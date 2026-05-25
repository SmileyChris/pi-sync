/**
 * pi-sync — P2P sync for pi coding agent settings
 *
 * Uses Automerge CRDTs to sync pi configuration (settings, extensions,
 * skills, models, prompts) across machines via WebSocket over Tailscale.
 * No central server required — each peer runs a lightweight WS server
 * and connects to every other peer. Works offline and merges
 * automatically when reconnected.
 *
 * Dependencies are loaded dynamically to avoid jiti/WASM import issues.
 *
 * Setup:
 *   1. cd ~/.pi/agent/extensions/pi-sync && npm install
 *   2. Edit ~/.config/pi-sync/config.json to list your peers
 *   3. On first machine, run `/sync:info` to get the document URL
 *   4. On other machines, run `/sync:import <url>` to join
 *
 * Commands:
 *   /sync:status       – show sync state, peers, document info
 *   /sync:info         – show document URL and pairing instructions
 *   /sync:import <url> – join an existing sync network
 *   /sync:unlink       – detach from the sync network
 *   /sync:peers        – manage peer list (add/remove/list/scan)
 *   /sync:config       – interactive settings panel (toggle sync categories)
 *   /sync:local-only   – manage local-only files
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  type SyncedFile,
  type PiConfigDocument,
  type SyncConfig,
  type Subdir,
  DEFAULT_SYNC_CONFIG,
  PI_DIR,
  CONFIG_DIR,
  CONFIG_PATH,
  DOC_URL_PATH,
  AM_STORAGE,
  TRASH_DIR,
  TOMBSTONE_TTL_MS,
  MASS_DELETE_LIMIT,
  normalizeFileKey,
  fileKey,
  getSubdir,
  isLocalOnly,
  shouldSync,
  applyJsonMergeInPlace,
  unwrapContent,
  syncedFileContentMatches,
  loadConfig as loadConfigFromFile,
  parsePeer,
  peerHost,
  collectExtensionFiles,
  collectSkillFiles,
  collectPromptFiles,
  dirtyKeysFromPatches,
  isTombstone,
  isPastTTL,
} from "./lib";

export type { SyncedFile, PiConfigDocument, SyncConfig };

// ── Module-level state ────────────────────────────────────────────────

let repo: any = null;
let handle: any = null;
let config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
let wss: any = null;
let watcher: fs.FSWatcher | null = null;
let ImmutableString: any = null; // set during repo init
const hostname = os.hostname();

// Live connection tracking — two tiers:
//  • wsConnectedPeers: actual WebSocket connections (inbound via wss, or outbound
//    via active Automerge sync). Set by connection events, never by TCP probes.
//  • tcpReachablePeers: peer port is open (best-effort via periodic TCP probe).
const wsConnectedPeers = new Map<string, { since: number; direction: "in" | "out" }>();
const tcpReachablePeers = new Set<string>();

// Export guard: prevent fs.watch from re-importing files we're writing
let exporting = false;
let suppressExportDepth = 0;

// Active session UI context (set in session_start). Module-scoped so the
// uncaughtException crash guard can surface notifications to the user.
let activeUi: ExtensionUIContext | null = null;
let crashGuardInstalled = false;

// Gate exports until the handle reaches the "ready" state (initial sync
// loaded). Without this gate, incremental sync patches fire `change` for
// each piece of an incoming snapshot and we end up writing a half-loaded
// tree to disk — and if the peer is killed mid-stream, that partial tree
// stays on disk after restart. Flipped by initRepo once the handle is
// ready, then by every export afterwards.
let initialSyncReady = false;
let standbyMode = false; // true while waiting for primary instance to exit

let pendingChanges = new Set<string>();
let watchTimer: ReturnType<typeof setTimeout> | null = null;
let widgetInterval: ReturnType<typeof setInterval> | null = null;
let purgeInterval: ReturnType<typeof setInterval> | null = null;
const WATCH_DEBOUNCE_MS = 500;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── Peer probing ─────────────────────────────────────────────────────

/** Quick TCP connect to check if a peer has pi-sync running */
async function probePeer(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/** TCP-probe all configured peers in parallel (best-effort reachability). */
async function probeAllPeers() {
  await Promise.allSettled(
    config.peers.map(async (peer) => {
      const parsed = parsePeer(peer);
      const host = parsed?.host ?? peerHost(peer);
      const port = parsed?.port ?? config.port;
      if (host === hostname) return;
      const ok = await probePeer(host, port);
      if (ok) tcpReachablePeers.add(host);
      else tcpReachablePeers.delete(host);
    }),
  );
}

let probeInterval: ReturnType<typeof setInterval> | null = null;
function startProbing() {
  if (probeInterval) return;
  probeAllPeers(); // immediate first probe
  probeInterval = setInterval(probeAllPeers, 15_000); // every 15s
}
function stopProbing() {
  if (probeInterval) { clearInterval(probeInterval); probeInterval = null; }
}

// ── Helpers ───────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write content atomically: tmp file in same dir, then rename. POSIX
 *  rename within one filesystem is atomic, so readers never observe a
 *  half-written file. */
function atomicWriteFile(absPath: string, content: string) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function loadConfig(): SyncConfig {
  return loadConfigFromFile(CONFIG_PATH, fs.existsSync, fs.readFileSync as any);
}

function readEntries(dir: string) {
  return fs.readdirSync(dir, { withFileTypes: true });
}

function readFileOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
}

function pathForFileKey(baseDir: string, rawKey: string): string | null {
  const key = normalizeFileKey(rawKey);
  if (!key) return null;
  const root = path.resolve(baseDir);
  const absPath = path.resolve(root, key);
  return absPath.startsWith(root + path.sep) ? absPath : null;
}

function piPathForKey(fileKey: string): string | null {
  return pathForFileKey(PI_DIR, fileKey);
}

function trashPathForKey(fileKey: string): string | null {
  return pathForFileKey(TRASH_DIR, fileKey);
}

function withSuppressedExport<T>(fn: () => T): T {
  suppressExportDepth++;
  try {
    return fn();
  } finally {
    suppressExportDepth--;
  }
}

// ── Trash helpers ────────────────────────────────────────────────────

function trashPathFor(fileKey: string): string | null {
  return trashPathForKey(fileKey);
}

/** Move PI_DIR/<key> → TRASH_DIR/<key>. Overwrites any prior trash copy. */
function moveToTrash(fileKey: string): boolean {
  const src = piPathForKey(fileKey);
  if (!src) return false;
  if (!fs.existsSync(src)) return false;
  const dest = trashPathFor(fileKey);
  if (!dest) return false;
  ensureDir(path.dirname(dest));
  try { fs.rmSync(dest, { force: true, recursive: true }); } catch {}
  fs.renameSync(src, dest);
  return true;
}

/** Move TRASH_DIR/<key> → PI_DIR/<key>. */
function restoreFromTrash(fileKey: string): boolean {
  const src = trashPathFor(fileKey);
  if (!src) return false;
  if (!fs.existsSync(src)) return false;
  const dest = piPathForKey(fileKey);
  if (!dest) return false;
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
  return true;
}

function purgeFromTrash(fileKey: string) {
  const trashPath = trashPathFor(fileKey);
  if (!trashPath) return;
  try { fs.rmSync(trashPath, { force: true }); } catch {}
}

function saveDocUrl(url: string) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(DOC_URL_PATH, url, "utf-8");
}

function loadDocUrl(): string | null {
  try {
    if (fs.existsSync(DOC_URL_PATH)) {
      return fs.readFileSync(DOC_URL_PATH, "utf-8").trim();
    }
  } catch {}
  return null;
}

function clearDocUrl() {
  try {
    if (fs.existsSync(DOC_URL_PATH)) fs.unlinkSync(DOC_URL_PATH);
  } catch {}
}

// ── Import: filesystem → document ─────────────────────────────────────

function importFile(doc: PiConfigDocument, fileKey: string): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return false;
  const subdir = getSubdir(key);
  if (!subdir) return false;
  if (!shouldSync(key, config)) return false;
  if (isLocalOnly(doc, key, hostname)) return false;

  const absPath = piPathForKey(key);
  if (!absPath) return false;
  // Stat instead of existsSync so we skip directories — fs.watch fires for
  // mkdir/rmdir too, and readFileSync on a dir throws EISDIR.
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const content = fs.readFileSync(absPath, "utf-8");

  if (subdir === "settings" || subdir === "models") {
    return applyJsonMergeInPlace(doc[subdir], content);
  }

  // extensions | skills | prompts
  const collection = doc[subdir] as Record<string, SyncedFile>;
  const existing = collection[key];
  if (syncedFileContentMatches(existing, content)) return false;

  const entry: SyncedFile = {
    content: ImmutableString ? new ImmutableString(content) : content,
    installedAt: existing?.installedAt ?? Date.now(),
  };
  if (existing?.source) entry.source = existing.source;
  collection[key] = entry;
  return true;
}

/** Collect all sync-eligible files under PI_DIR, returns fileKeys. */
function collectAllFiles(): string[] {
  const files: string[] = [];

  if (config.syncSettings && fs.existsSync(path.join(PI_DIR, "settings.json")))
    files.push("settings.json");
  if (config.syncModels && fs.existsSync(path.join(PI_DIR, "models.json")))
    files.push("models.json");

  const extDir = path.join(PI_DIR, "extensions");
  if (config.syncExtensions && fs.existsSync(extDir)) {
    files.push(...collectExtensionFiles(extDir, readEntries));
  }
  const skillsDir = path.join(PI_DIR, "skills");
  if (config.syncSkills && fs.existsSync(skillsDir)) {
    files.push(...collectSkillFiles(skillsDir, readEntries));
  }
  const promptsDir = path.join(PI_DIR, "prompts");
  if (config.syncPrompts && fs.existsSync(promptsDir)) {
    files.push(...collectPromptFiles(promptsDir, readEntries));
  }

  return files;
}

function importAllFiles(doc: PiConfigDocument): boolean {
  let changed = false;
  for (const fileKey of collectAllFiles()) {
    if (importFile(doc, fileKey)) changed = true;
  }
  return changed;
}

// ── Export: document → filesystem ─────────────────────────────────────

function exportFile(doc: PiConfigDocument, fileKey: string): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return false;
  if (isLocalOnly(doc, key, hostname)) return false;
  const subdir = getSubdir(key);
  if (!subdir) return false;
  if (!shouldSync(key, config)) return false;

  const absPath = piPathForKey(key);
  if (!absPath) return false;

  if (subdir === "settings" || subdir === "models") {
    const content = JSON.stringify(doc[subdir], null, 2) + "\n";
    if (readFileOrEmpty(absPath) === content) return false;
    atomicWriteFile(absPath, content);
    return true;
  }

  const collection = doc[subdir] as Record<string, SyncedFile>;
  const synced = collection[fileKey] ?? collection[key];
  if (!synced) return false;

  if (isTombstone(synced)) {
    // Remote peer (or a previous local action) tombstoned this entry.
    // Move our copy to the trash dir; the entry stays in the doc until
    // TTL purge or explicit /sync:trash empty.
    if (fs.existsSync(absPath)) {
      moveToTrash(key);
      return true;
    }
    return false;
  }

  const content = unwrapContent(synced) ?? "";
  if (readFileOrEmpty(absPath) === content) return false;
  atomicWriteFile(absPath, content);
  return true;
}

/** Treat the doc as uninitialized if it has no synced content yet.
 *  Writing the empty shape to disk on first run would wipe local files. */
function isDocEmpty(doc: PiConfigDocument): boolean {
  return (
    Object.keys(doc.extensions).length === 0 &&
    Object.keys(doc.skills).length === 0 &&
    Object.keys(doc.prompts).length === 0 &&
    Object.keys(doc.settings).length === 0 &&
    Object.keys(doc.models).length === 0
  );
}

function exportKeys(doc: PiConfigDocument, keys: Iterable<string>): boolean {
  exporting = true;
  try {
    let changed = false;
    for (const key of keys) {
      if (exportFile(doc, key)) changed = true;
    }
    return changed;
  } finally {
    exporting = false;
  }
}

function exportAllFiles(doc: PiConfigDocument): boolean {
  if (isDocEmpty(doc)) {
    console.log("[pi-sync] Skipping export: document appears empty (first sync?)");
    return false;
  }
  return exportKeys(doc, [
    "settings.json",
    "models.json",
    ...Object.keys(doc.extensions),
    ...Object.keys(doc.skills),
    ...Object.keys(doc.prompts),
  ]);
}

// ── Watcher ───────────────────────────────────────────────────────────

async function flushPendingChanges() {
  // Skip if exporting to avoid feedback loop: export writes file →
  // watcher fires → import reads it back → another change cycle
  if (!handle || exporting) return;
  const files = [...pendingChanges];
  pendingChanges.clear();

  const currentDoc = await handle.doc?.();
  if (!currentDoc) return;

  // Partition into present (add/update) vs missing (potential delete).
  // A "missing" key only counts as a delete if the doc still has a LIVE
  // entry — re-deletion of an already-tombstoned entry is a no-op.
  const present: string[] = [];
  const deletions: string[] = [];
  for (const rawKey of files) {
    const key = normalizeFileKey(rawKey);
    if (!key || !shouldSync(key, config)) continue;
    const absPath = piPathForKey(key);
    if (!absPath) continue;
    if (fs.existsSync(absPath)) {
      present.push(key);
      continue;
    }
    const subdir = getSubdir(key);
    // Only collection sections are tombstoneable. Settings/models are
    // whole-file JSON; their absence is treated as "no changes" so peers
    // don't propagate transient deletions of those files.
    if (subdir !== "extensions" && subdir !== "skills" && subdir !== "prompts") continue;
    const collection = currentDoc[subdir] as Record<string, SyncedFile>;
    const entry = collection?.[key];
    if (entry && !isTombstone(entry)) deletions.push(key);
  }

  // Mass-delete brake: refuse to propagate large bursts. The user likely
  // ran `rm -rf` / `git clean` / similar — better to require them to
  // resurrect on disk (or use /sync:trash empty per file) than silently
  // wipe the cluster.
  let blockedDeletions = false;
  if (deletions.length > MASS_DELETE_LIMIT) {
    console.error(
      `[pi-sync] Mass-delete brake: ${deletions.length} files vanished in one flush ` +
      `(limit ${MASS_DELETE_LIMIT}). Holding tombstones. Restore the files on disk ` +
      `to dismiss, or run \`/sync:trash empty <path>\` per file to confirm.`,
    );
    blockedDeletions = true;
  }

  withSuppressedExport(() => {
    handle.change?.((doc: PiConfigDocument) => {
      for (const key of present) {
        try {
          importFile(doc, key);
        } catch (err: any) {
          console.error(`[pi-sync] importFile failed for ${key}:`, err?.message ?? err);
        }
      }
      if (blockedDeletions) return;
      for (const key of deletions) {
        const subdir = getSubdir(key) as "extensions" | "skills" | "prompts";
        const collection = doc[subdir] as Record<string, SyncedFile>;
        const entry = collection[key];
        if (!entry) continue;
        entry.deletedAt = Date.now();
        entry.deletedBy = hostname;
      }
    });
  });
}

function startFileWatcher() {
  if (watcher) return;
  try {
    watcher = fs.watch(PI_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      if (
        filename.includes("node_modules") ||
        filename.includes(".git") ||
        filename.startsWith("sessions/") ||
        filename.startsWith("npm/") ||
        filename.startsWith("git/") ||
        filename === "auth.json" ||
        filename.startsWith("am-storage") ||
        filename.startsWith(".trash") ||
        filename.startsWith(".obgo")
      ) return;

      const absPath = path.join(PI_DIR, filename);
      const key = normalizeFileKey(fileKey(absPath));
      if (!key || !shouldSync(key, config)) return;
      const subdir = getSubdir(key);
      if (!subdir) return;

      // Skip directory events — fs.watch fires for mkdir/rmdir too and we
      // only sync files. Cheap upfront check stops dogpiles where a dir
      // keeps generating events that fail import.
      try {
        const st = fs.statSync(absPath);
        if (st.isDirectory()) return;
      } catch {
        // Stat failed (race: deletion). Let flush handle it as a missing
        // key → potential tombstone.
      }

      pendingChanges.add(key);
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(flushPendingChanges, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    console.error("[pi-sync] fs.watch failed:", err);
  }
}

function stopFileWatcher() {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
}

// ── Tombstone TTL purge ──────────────────────────────────────────────

/** Find and hard-delete tombstones older than TOMBSTONE_TTL_MS. Trash
 *  files for those entries are removed too. Returns count purged. */
async function purgePastTTL(): Promise<number> {
  if (!handle) return 0;
  const doc = await handle.doc?.();
  if (!doc) return 0;
  const now = Date.now();
  type Hit = { section: "extensions" | "skills" | "prompts"; key: string };
  const purgeable: Hit[] = [];
  for (const section of ["extensions", "skills", "prompts"] as const) {
    const col = doc[section] as Record<string, SyncedFile>;
    for (const [key, entry] of Object.entries(col)) {
      if (isPastTTL(entry, now)) purgeable.push({ section, key });
    }
  }
  if (purgeable.length === 0) return 0;
  handle.change?.((d: PiConfigDocument) => {
    for (const p of purgeable) {
      const col = d[p.section] as Record<string, SyncedFile>;
      delete col[p.key];
    }
  });
  for (const p of purgeable) purgeFromTrash(p.key);
  console.log(`[pi-sync] Purged ${purgeable.length} tombstone(s) past TTL`);
  return purgeable.length;
}

function startPurgeTimer() {
  if (purgeInterval) return;
  purgePastTTL().catch(() => {});
  purgeInterval = setInterval(() => { purgePastTTL().catch(() => {}); }, PURGE_INTERVAL_MS);
}

function stopPurgeTimer() {
  if (purgeInterval) { clearInterval(purgeInterval); purgeInterval = null; }
}

// ── Repo lifecycle ────────────────────────────────────────────────────

/** True iff err originates from Automerge wasm or matches a known
 *  Automerge-only error message. We narrow the crash guard to these so we
 *  don't mask unrelated bugs in pi or other extensions. */
function isAutomergeError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { stack?: unknown; message?: unknown };
  const s = String(e.stack ?? e.message ?? err);
  return /automerge_wasm|PatchLogMismatch|recursive use of an object|RuntimeError: unreachable|Cannot create a reference to an existing document/.test(
    s,
  );
}

/** Move ~/.pi/am-storage out of the way so the next start gets a clean
 *  repo (it will re-sync from peers via the saved doc URL). Returns the
 *  destination path, or null if there was nothing to move. */
function quarantineStorage(): string | null {
  try {
    if (!fs.existsSync(AM_STORAGE)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${AM_STORAGE}.corrupt.${ts}`;
    fs.renameSync(AM_STORAGE, dest);
    return dest;
  } catch (e: any) {
    console.error("[pi-sync] Failed to quarantine storage:", e?.message ?? e);
    return null;
  }
}

/** Install a one-shot guard against Automerge wasm panics. Without this,
 *  a PatchLogMismatch (or follow-on "recursive use of an object") tears
 *  down the whole pi process. The guard keeps pi alive, stops sync, and
 *  quarantines storage so the next start is clean. */
function installCrashGuard() {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;

  const handle = (err: unknown, kind: "exception" | "rejection") => {
    if (!isAutomergeError(err)) {
      // Log and swallow. Re-throwing here would re-enter this same handler
      // (uncaughtException loops on itself), so we leave the error to
      // pi's own top-level handler / surface it via the log only. Avoid
      // process.exit so other extensions aren't taken down by ours.
      console.error(`[pi-sync] uncaught ${kind} (not automerge):`, err);
      return;
    }
    const msg = (err as any)?.message ?? String(err);
    console.error(`[pi-sync] Automerge ${kind} caught:`, msg);
    const dest = quarantineStorage();
    void shutdownRepo().catch(() => {});
    const note =
      `pi-sync hit an Automerge crash and stopped.${dest ? `\nStorage quarantined → \`${dest}\`` : ""}\n` +
      `Run \`/reload\` to restart sync. If the crash recurs, run \`/sync:unlink\` and re-import from a peer.`;
    try { activeUi?.notify(note, "warning"); } catch {}
  };

  process.on("uncaughtException", (err) => handle(err, "exception"));
  process.on("unhandledRejection", (reason) => handle(reason, "rejection"));
}

async function initRepo(pi: ExtensionAPI): Promise<void> {
  ensureDir(CONFIG_DIR);
  ensureDir(AM_STORAGE);
  ensureDir(TRASH_DIR);

  installCrashGuard();

  // Dynamic imports to avoid jiti/WASM top-level import issues
  const [{ WebSocketServer }, { Repo, ImmutableString: IS }, { NodeFSStorageAdapter }, netModule] =
    await Promise.all([
      import("ws"),
      import("@automerge/automerge-repo"),
      import("@automerge/automerge-repo-storage-nodefs"),
      import("@automerge/automerge-repo-network-websocket"),
    ]);

  // Store for use in importFile/exportFile
  ImmutableString = IS;

  const { NodeWSServerAdapter, WebSocketClientAdapter } = netModule;

  // ── WebSocket server ──────────────────────────────────────────────

  wss = new WebSocketServer({ port: config.port });

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[pi-sync] Port ${config.port} is in use. ` +
        `Edit ~/.config/pi-sync/config.json to change.`
      );
    } else {
      console.error("[pi-sync] WS server error:", err.message);
    }
  });

  // Track real WS connections (inbound = another peer connected to us)
  wss.on("connection", (ws: any, req: any) => {
    const remoteAddr = req.socket?.remoteAddress || "unknown";
    const host = remoteAddr.replace(/^::ffff:/, "");
    wsConnectedPeers.set(host, { since: Date.now(), direction: "in" });
    ws.on("close", () => wsConnectedPeers.delete(host));
  });

  // ── Network adapters ──────────────────────────────────────────────

  const serverAdapter = new NodeWSServerAdapter(wss);
  const adapters: any[] = [serverAdapter];

  for (const peer of config.peers) {
    if (peerHost(peer) === hostname) continue;
    adapters.push(new WebSocketClientAdapter(`ws://${peer}`));
  }

  // ── Create repo ───────────────────────────────────────────────────

  repo = new Repo({
    network: adapters,
    storage: new NodeFSStorageAdapter(AM_STORAGE),
    peerId: `pi-sync-${hostname}`,
  });

  // ── Find or create document ───────────────────────────────────────

  const docUrl = loadDocUrl();

  if (docUrl) {
    // Joining an existing network — find the document, then push our
    // local state so other peers learn about any extensions/skills
    // this machine has that they don't know about yet.
    handle = await repo.find(docUrl);
  } else {
    // First run — create fresh document, then import files one at a time
    handle = repo.create({
      settings: {},
      models: {},
      extensions: {},
      skills: {},
      prompts: {},
      localOnly: {
        // pi-sync extension must stay local — WASM binaries and peer
        // config are platform/machine-specific.
        "extensions/pi-sync": [hostname],
      },
      lastSync: {},
    });
    saveDocUrl(handle.url);

    // Import files incrementally to avoid WASM capacity overflow
    const files = collectAllFiles();
    for (const fileKey of files) {
      handle.change((doc: PiConfigDocument) => {
        importFile(doc, fileKey);
      });
    }
    console.log(`[pi-sync] Imported ${files.length} files into new document`);
  }

  // Attach the change listener BEFORE awaiting whenReady so we don't miss
  // patches, but gate exports on `initialSyncReady`. Without the gate,
  // each sync patch arriving mid-snapshot writes a partial tree to disk.
  handle.on?.("change", (payload: any) => {
    if (!initialSyncReady) return;
    const doc = payload?.doc;
    if (!doc) return;
    if (suppressExportDepth > 0) return;
    if (isDocEmpty(doc)) return;
    const patches: any[] = payload?.patches ?? [];
    if (patches.length === 0) {
      exportAllFiles(doc);
      return;
    }
    exportKeys(doc, dirtyKeysFromPatches(patches));
  });

  // Wait for the doc to reach "ready" before doing any export work.
  // - Newly created docs (above) resolve immediately.
  // - Joining peers resolve once the initial snapshot is loaded.
  // If the join is interrupted (network drop, peer killed), whenReady
  // never resolves and nothing gets exported — disk stays clean.
  try {
    await handle.whenReady?.();
  } catch (err: any) {
    console.error("[pi-sync] handle never became ready:", err?.message ?? err);
    return;
  }

  const readyDoc = await handle.doc?.();
  if (readyDoc) {
    // Push our local files into the doc now that we know the full remote
    // state, so peers learn about anything we have that they don't.
    withSuppressedExport(() => {
      handle.change?.((doc: PiConfigDocument) => {
        importAllFiles(doc);
        doc.lastSync[hostname] = Date.now();
      });
    });

    // One bulk export of the full tree, then mark ready so subsequent
    // change patches are exported incrementally.
    if (!isDocEmpty(readyDoc)) {
      exportAllFiles(readyDoc);
    }
  }
  initialSyncReady = true;
}

async function shutdownRepo() {
  stopFileWatcher();
  stopProbing();
  stopPurgeTimer();
  if (widgetInterval) { clearInterval(widgetInterval); widgetInterval = null; }
  wsConnectedPeers.clear();
  tcpReachablePeers.clear();
  initialSyncReady = false;
  if (repo) {
    try { await repo.shutdown?.(); } catch {}
  }
  if (wss) {
    try { wss.close?.(); } catch {}
    wss = null;
  }
  repo = null;
  handle = null;
}

// ── Watchdog: waits for the primary instance to exit, then takes over ─

async function watchAndTakeOver(pi: ExtensionAPI) {
  standbyMode = true;
  const { default: WebSocket } = await import("ws");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${config.port}`);
    ws.on("close", () => resolve());
    ws.on("error", () => resolve());
  });

  // Jitter: wait 50–500 ms before attempting to take over so multiple
  // standbys don't race for the port at the exact same instant.
  const jitterMs = Math.floor(Math.random() * 450) + 50;
  await new Promise((r) => setTimeout(r, jitterMs));

  // Did another standby already claim the port while we waited?
  if (await probePeer("localhost", config.port, 500)) {
    console.log(
      `[pi-sync] Another instance took port ${config.port} — resuming standby`,
    );
    watchAndTakeOver(pi).catch((e: any) =>
      console.error("[pi-sync] Watchdog failed:", e?.message ?? e),
    );
    return;
  }

  standbyMode = false;
  await initRepo(pi);

  // Refresh the status widget immediately after takeover so the TUI
  // layout re-flows and the footer line doesn't appear off by one.
  // (Otherwise the user waits up to 5 s for the next timer tick.)
  if (activeUi && handle) {
    try {
      const doc = await handle.doc?.();
      updateStatusWidget(doc);
    } catch {}
  }

  // Kick off the runtime loops that initRepo normally starts under the
  // non-standby path (watcher, probing, purge).
  startFileWatcher();
  startPurgeTimer();
  startProbing();
}

// ── Extension entry point ─────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  config = loadConfig();

  // Write default config if missing
  ensureDir(CONFIG_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(DEFAULT_SYNC_CONFIG, null, 2) + "\n",
    );
  }

  // ── Commands (available immediately, before repo init) ────────────

  /** Write updated config to disk */
  function saveConfig() {
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  }

  pi.registerCommand("sync:status", {
    description: "Show pi-sync status, peers, and sync toggles",
    handler: async (_args, ctx) => {
      const doc = handle ? await handle.doc?.() : undefined;
      const docUrl = loadDocUrl();
      const onOff = (b: boolean) => b ? "✅" : "❌";
      const lines = [
        `**pi-sync**  ─  \`${hostname}\`  :${config.port}`,
        ``,
        `Document: \`${docUrl ? docUrl.slice(0, 28) + "…" : "not set"}\``,
        `Peers (${config.peers.length}):`,
        ...(config.peers.length > 0
          ? config.peers.map((p) => {
              const h = peerHost(p);
              const mark = wsConnectedPeers.has(h) ? "🟢" : tcpReachablePeers.has(h) ? "🔵" : "🔴";
              return `  ${mark} \`${p}\``;
            })
          : [`  _none configured — use \`/sync:peers add <host:port>\`_`]
        ),
        ``,
        `Syncing: ${onOff(config.syncSettings)} settings  ${onOff(config.syncModels)} models  ${onOff(config.syncExtensions)} extensions  ${onOff(config.syncSkills)} skills  ${onOff(config.syncPrompts)} prompts`,
        ``,
        `Tracked: 🔌 ${Object.keys(doc?.extensions ?? {}).length} extensions  🔧 ${Object.keys(doc?.skills ?? {}).length} skills  ✏️ ${Object.keys(doc?.prompts ?? {}).length} prompts`,
        `Local-only: \`${Object.keys(doc?.localOnly ?? {}).length}\` entries`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sync:peers", {
    description: "Manage peers: add, remove, list, scan",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const action = parts[0] || "list";
      const target = parts.slice(1).join(" ");

      if (action === "list" || action === "ls") {
        if (config.peers.length === 0) {
          ctx.ui.notify(
            "No peers configured.\n\nAdd one: \`/sync:peers add laptop.tailnet.ts.net:3030\`\nAuto-discover: \`/sync:peers scan\`",
            "info",
          );
        } else {
          const list = config.peers.map((p) => {
            const h = peerHost(p);
            const mark = wsConnectedPeers.has(h) ? "🟢" : tcpReachablePeers.has(h) ? "🔵" : "🔴";
            return `  ${mark} \`${p}\``;
          }).join("\n");
          ctx.ui.notify(`**Peers (${config.peers.length}):**\n${list}\n\n🟢 WS-connected  🔵 TCP reachable  🔴 offline`, "info");
        }
        return;
      }

      if (action === "add" && target) {
        if (!target.includes(":")) {
          ctx.ui.notify("Format: \`host:port\` (e.g. \`laptop.tailnet.ts.net:3030\`)", "error");
          return;
        }
        if (config.peers.includes(target)) {
          ctx.ui.notify(`\`${target}\` is already in the peer list.`, "info");
          return;
        }
        if (peerHost(target) === hostname) {
          ctx.ui.notify("That's your own hostname — not adding self.", "info");
          return;
        }
        config.peers.push(target);
        saveConfig();
        ctx.ui.notify(
          `Added peer \`${target}\`. Restart pi or run \`/reload\` to connect.`,
          "info",
        );
        return;
      }

      if (action === "remove" || action === "rm") {
        if (!target) {
          ctx.ui.notify("Usage: \`/sync:peers remove <host>\` or \`/sync:peers remove <host:port>\`", "error");
          return;
        }
        // Match either "host:port" exactly or just the host portion — never
        // a string-prefix match (which would remove "host2:3030" when the
        // user asked to remove "host").
        const targetHost = peerHost(target);
        const before = config.peers.length;
        config.peers = config.peers.filter(
          (p) => p !== target && peerHost(p) !== targetHost,
        );
        if (config.peers.length === before) {
          ctx.ui.notify(`Peer \`${target}\` not found.`, "info");
        } else {
          wsConnectedPeers.delete(targetHost);
          tcpReachablePeers.delete(targetHost);
          saveConfig();
          ctx.ui.notify(`Removed \`${target}\` from peers.`, "info");
        }
        return;
      }

      if (action === "scan") {
        // Auto-discover pi-sync peers via Tailscale + TCP probe
        ctx.ui.notify("Scanning Tailscale network for pi-sync peers…", "info");
        try {
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(exec);
          const { stdout } = await execAsync("tailscale status --json", {
            encoding: "utf-8" as BufferEncoding,
            timeout: 5000,
          });
          const status = JSON.parse(stdout);
          const suffix = status.MagicDNSSuffix || "";
          const tailscalePeers = status.Peer
            ? (Object.values(status.Peer) as any[])
                .filter((p: any) => p.Online && p.HostName !== hostname)
                .map((p: any) => ({
                  host: p.HostName,
                  fqdn: suffix ? `${p.HostName}.${suffix}` : p.HostName,
                }))
            : [];

          if (tailscalePeers.length === 0) {
            ctx.ui.notify("No online Tailscale peers found.", "info");
            return;
          }

          // Probe each in parallel to check if pi-sync is running
          const probed: { host: string; fqdn: string; reachable: boolean }[] =
            await Promise.all(
              tailscalePeers.map(async (p) => ({
                ...p,
                reachable: await probePeer(p.fqdn, config.port),
              })),
            );

          const syncPeers = probed.filter((p) => p.reachable);
          const nonSyncPeers = probed.filter((p) => !p.reachable);

          if (syncPeers.length === 0) {
            ctx.ui.notify(
              `Found ${probed.length} Tailscale peer(s), but none are running pi-sync on port ${config.port}.\n\n` +
              `Offline peers: ${nonSyncPeers.map((p) => `\`${p.host}\``).join(", ") || "none"}`,
              "info",
            );
            return;
          }

          const isConfigured = (host: string) =>
            config.peers.some((ep) => peerHost(ep) === host);
          const newSyncPeers = syncPeers.filter((p) => !isConfigured(p.host));
          const alreadyConfigured = syncPeers.filter((p) => isConfigured(p.host));

          if (alreadyConfigured.length > 0) {
            ctx.ui.notify(
              `Already configured:\n${alreadyConfigured.map((p) => `  ✅ \`${p.fqdn}:${config.port}\``).join("\n")}`,
              "info",
            );
          }

          if (newSyncPeers.length === 0) {
            if (alreadyConfigured.length === 0) {
              ctx.ui.notify("No new pi-sync peers to add.", "info");
            }
            return;
          }

          const peerOptions = newSyncPeers.map((p) => `${p.fqdn}:${config.port}`);
          const selection = await ctx.ui.select(
            `Found ${newSyncPeers.length} pi-sync peer(s). Select one to add:`,
            newSyncPeers.length > 1 ? ["Add all", ...peerOptions] : peerOptions,
          );

          if (selection) {
            const selectedPeers = selection === "Add all" ? peerOptions : [selection];
            for (const p of selectedPeers) {
              if (!config.peers.includes(p)) config.peers.push(p);
            }
            saveConfig();
            ctx.ui.notify(
              `Added ${selectedPeers.length} peer(s). Run \`/reload\` to connect.`,
              "info",
            );
          }
        } catch (e: any) {
          ctx.ui.notify(
            `Scan failed: ${e.message}\n\nRequires \`tailscale\` CLI installed and authenticated.`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(
        "**Usage:**\n  \`/sync:peers list\`\n  \`/sync:peers add <host:port>\`\n  \`/sync:peers remove <host>\`\n  \`/sync:peers scan\`  (auto-discover via Tailscale)",
        "info",
      );
    },
  });

  pi.registerCommand("sync:config", {
    description: "Toggle what gets synced (interactive settings panel)",
    handler: async (_args, ctx) => {
      const buildItems = (): SettingItem[] => [
        { id: "syncSettings", label: "Settings", currentValue: config.syncSettings ? "on" : "off", values: ["on", "off"] },
        { id: "syncModels", label: "Models", currentValue: config.syncModels ? "on" : "off", values: ["on", "off"] },
        { id: "syncExtensions", label: "Extensions", currentValue: config.syncExtensions ? "on" : "off", values: ["on", "off"] },
        { id: "syncSkills", label: "Skills", currentValue: config.syncSkills ? "on" : "off", values: ["on", "off"] },
        { id: "syncPrompts", label: "Prompts", currentValue: config.syncPrompts ? "on" : "off", values: ["on", "off"] },
      ];

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Sync Config ")), 1, 0));

        const settingsList = new SettingsList(
          buildItems(),
          Math.min(buildItems().length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            const key = id as keyof SyncConfig;
            config[key] = (newValue === "on");
            saveConfig();
            // Update the list item in-place
            settingsList.updateValue(id, newValue);
          },
          () => done(undefined),
        );
        container.addChild(settingsList);

        container.addChild(new Text(theme.fg("dim", "↑↓ select  •  space toggle  •  esc close"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      }, { overlay: true });
    },
  });

  const showInviteInfo = async (ctx: { ui: ExtensionUIContext }) => {
    const docUrl = loadDocUrl();
    if (!docUrl) {
      ctx.ui.notify("No document yet — waiting for repo to initialize.", "info");
      return;
    }
    const lines = [
      `**pi-sync invite**`,
      ``,
      `Your join key (share this with the other machine):`,
      ``,
      `\`${docUrl}\``,
      ``,
      `**On the other machine:**`,
      `1. Install pi-sync (same setup as this machine)`,
      `2. \`/sync:peers add ${hostname}:${config.port}\``,
      `3. \`/sync:import ${docUrl}\``,
      `4. \`/reload\``,
      ``,
      `They'll automatically pull all synced extensions and skills.`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("sync:info", {
    description: "Show invite key and instructions for pairing machines",
    handler: async (_args, ctx) => showInviteInfo(ctx),
  });

  pi.registerCommand("sync:import", {
    description: "Import a document URL from another pi-sync peer",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /sync:import <automerge-url>", "error");
        return;
      }
      const url = args.trim();
      if (!url.startsWith("automerge:")) {
        ctx.ui.notify("Invalid URL — should start with 'automerge:'", "error");
        return;
      }
      saveDocUrl(url);
      ctx.ui.notify(
        `Document URL saved. Run \`/reload\` to join the network.`,
        "info",
      );
    },
  });

  pi.registerCommand("sync:unlink", {
    description: "Detach from the sync network and start fresh on next reload",
    handler: async (_args, ctx) => {
      const docUrl = loadDocUrl();
      if (!docUrl) {
        ctx.ui.notify("No sync document to unlink — you're not connected to a network.", "info");
        return;
      }
      // Shut down sync, clear the doc URL, and remove local Automerge
      // storage so the next reload starts a fresh document.
      await shutdownRepo();
      clearDocUrl();
      try {
        fs.rmSync(AM_STORAGE, { recursive: true, force: true });
      } catch {}
      // Re-initialize with a fresh state
      config = loadConfig();
      try {
        await initRepo(pi);
        // After fresh init, restart runtime loops stopped during unlink.
        startFileWatcher();
        startPurgeTimer();
        startProbing();
        startWidgetTimer();
        ctx.ui.notify(
          "Unlinked from sync network. A fresh document has been created.\n\n" +
          "To re-join later, use \`/sync:import <url>\` from a paired machine.",
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(
          `Unlinked but failed to re-initialize: ${e.message}\nRun \`/reload\` to start fresh.`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("sync:trash", {
    description: "Review and manage soft-deleted files (tombstones)",
    handler: async (args, ctx) => {
      if (!handle) {
        ctx.ui.notify("pi-sync not initialized yet", "info");
        return;
      }
      const doc = await handle.doc?.();
      if (!doc) {
        ctx.ui.notify("Document not ready yet", "info");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/);
      const action = parts[0] || "list";
      const fileArg = normalizeFileKey(parts.slice(1).join(" ")) ?? "";

      type Hit = { key: string; section: "extensions" | "skills" | "prompts"; entry: SyncedFile };
      const tombstones: Hit[] = [];
      for (const section of ["extensions", "skills", "prompts"] as const) {
        const col = doc[section] as Record<string, SyncedFile>;
        for (const [key, entry] of Object.entries(col)) {
          if (isTombstone(entry)) tombstones.push({ key, section, entry });
        }
      }

      const ttlDays = Math.round(TOMBSTONE_TTL_MS / 86_400_000);

      if (action === "list" || action === "ls") {
        if (tombstones.length === 0) {
          ctx.ui.notify(`Trash is empty. TTL: ${ttlDays} days.`, "info");
          return;
        }
        const now = Date.now();
        const lines = tombstones.map(({ key, entry }) => {
          const ageDays = Math.floor((now - (entry.deletedAt as number)) / 86_400_000);
          const past = isPastTTL(entry, now) ? "  ⚠ past TTL" : "";
          return `  \`${key}\` — by \`${entry.deletedBy ?? "?"}\`, ${ageDays}d ago${past}`;
        });
        ctx.ui.notify(
          `**Trash (${tombstones.length}):**\n${lines.join("\n")}\n\n` +
          `Restore: \`/sync:trash restore <path>\`\n` +
          `Finalize: \`/sync:trash empty <path>\`\n` +
          `Finalize all past TTL: \`/sync:trash empty\``,
          "info",
        );
        return;
      }

      if (action === "restore") {
        if (!fileArg) {
          ctx.ui.notify("Usage: \`/sync:trash restore <path>\`", "error");
          return;
        }
        const hit = tombstones.find((t) => t.key === fileArg);
        if (!hit) {
          ctx.ui.notify(`No tombstone for \`${fileArg}\`.`, "info");
          return;
        }
        handle.change?.((d: PiConfigDocument) => {
          const col = d[hit.section] as Record<string, SyncedFile>;
          const e = col[fileArg];
          if (e) { delete e.deletedAt; delete e.deletedBy; }
        });
        restoreFromTrash(fileArg);
        ctx.ui.notify(`Restored \`${fileArg}\`.`, "info");
        return;
      }

      if (action === "empty") {
        if (fileArg) {
          const hit = tombstones.find((t) => t.key === fileArg);
          if (!hit) {
            ctx.ui.notify(`No tombstone for \`${fileArg}\`.`, "info");
            return;
          }
          handle.change?.((d: PiConfigDocument) => {
            const col = d[hit.section] as Record<string, SyncedFile>;
            delete col[fileArg];
          });
          purgeFromTrash(fileArg);
          ctx.ui.notify(`Finalized deletion of \`${fileArg}\`.`, "info");
          return;
        }
        const n = await purgePastTTL();
        ctx.ui.notify(
          n === 0
            ? `No tombstones past TTL (${ttlDays} days).`
            : `Finalized ${n} tombstone(s) past TTL.`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage:\n" +
        "  \`/sync:trash\`                  — list tombstones\n" +
        "  \`/sync:trash restore <path>\`   — un-delete\n" +
        "  \`/sync:trash empty <path>\`     — finalize one\n" +
        "  \`/sync:trash empty\`            — finalize all past TTL",
        "info",
      );
    },
  });

  pi.registerCommand("sync:local-only", {
    description: "Manage local-only files (add/remove/list)",
    handler: async (args, ctx) => {
      if (!handle) {
        ctx.ui.notify("pi-sync not initialized yet", "info");
        return;
      }
      const doc = await handle.doc?.();
      if (!doc) {
        ctx.ui.notify("Document not ready yet", "info");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/);
      const action = parts[0];
      const fileArg = parts[1] ? normalizeFileKey(parts[1]) : null;

      if (action === "list" || !action) {
        const entries = Object.entries(doc.localOnly as Record<string, string[]>);
        if (entries.length === 0) {
          ctx.ui.notify("No local-only files configured.", "info");
        } else {
          const list = entries.map(([k, v]) => `  \`${k}\` → [${v.join(", ")}]`).join("\n");
          ctx.ui.notify(`**Local-only files:**\n${list}`, "info");
        }
        return;
      }

      if (action === "add" && fileArg) {
        const targetHost = parts[2] || hostname;
        handle.change?.((d: PiConfigDocument) => {
          if (!d.localOnly[fileArg]) d.localOnly[fileArg] = [];
          if (!d.localOnly[fileArg].includes(targetHost)) {
            d.localOnly[fileArg].push(targetHost);
          }
        });
        ctx.ui.notify(`Marked \`${fileArg}\` as local-only for \`${targetHost}\``, "info");
        return;
      }

      if (action === "remove" && fileArg) {
        handle.change?.((d: PiConfigDocument) => {
          delete d.localOnly[fileArg];
        });
        ctx.ui.notify(`Removed local-only from \`${fileArg}\``, "info");
        return;
      }

      ctx.ui.notify(
        "Usage:\n  /sync:local-only list\n  /sync:local-only add <path> [hostname]\n  /sync:local-only remove <path>",
        "info",
      );
    },
  });

  // ── Status widget (footer) ────────────────────────────────────────

  function updateStatusWidget(doc?: PiConfigDocument) {
    if (!activeUi) return;

    if (standbyMode) {
      activeUi.setWidget("pi-sync", [
        `⛓️  sync standby`,
      ]);
      return;
    }

    const extCount = Object.keys(doc?.extensions ?? {}).length;
    const skillCount = Object.keys(doc?.skills ?? {}).length;
    const promptCount = Object.keys(doc?.prompts ?? {}).length;
    const total = config.peers.length;

    // Count WS-connected (real sync) and TCP-only reachable peers
    const wsOnline = config.peers.filter((p) => wsConnectedPeers.has(peerHost(p))).length;
    const tcpOnly = config.peers.filter((p) => {
      const h = peerHost(p);
      return !wsConnectedPeers.has(h) && tcpReachablePeers.has(h);
    }).length;

    let peerStatus: string;
    if (total === 0) {
      peerStatus = "no peers";
    } else if (wsOnline === 0 && tcpOnly === 0) {
      peerStatus = `${total} configured (all offline)`;
    } else {
      const parts: string[] = [];
      if (wsOnline > 0) parts.push(`${wsOnline} synced`);
      if (tcpOnly > 0) parts.push(`${tcpOnly} reachable`);
      peerStatus = parts.join(", ");
    }

    let peerList = "";
    if (total > 0) {
      peerList = config.peers
        .map((p) => {
          const host = peerHost(p);
          const mark = wsConnectedPeers.has(host) ? "🟢" : tcpReachablePeers.has(host) ? "🔵" : "🔴";
          return mark + " " + host;
        })
        .join(" ");
    }

    activeUi.setWidget("pi-sync", [
      `🔗 ${peerStatus}  │  🔌 ${extCount}  🔧 ${skillCount}  ✏️  ${promptCount}`,
      ...(peerList ? [peerList] : []),
    ]);
  }

  // Update widget periodically + after probing
  function startWidgetTimer() {
    if (widgetInterval) return;
    widgetInterval = setInterval(() => {
      if (handle) {
        try {
          updateStatusWidget(handle.doc?.());
        } catch {}
      } else {
        updateStatusWidget();
      }
    }, 5000);
  }
  startWidgetTimer();

  // ── Lifecycle ─────────────────────────────────────────────────────
  // Register these before init so they're always active (even when
  // waiting for takeover).

  pi.on("session_start", async (_event, ctx) => {
    activeUi = ctx.ui;
    updateStatusWidget(); // show standby/active state immediately
    if (!handle) return;
    const doc = await handle.doc?.();
    if (!doc) return;

    withSuppressedExport(() => {
      handle.change?.((d: PiConfigDocument) => {
        importAllFiles(d);
      });
    });

    // Start health probing
    startProbing();
    updateStatusWidget(doc);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    stopProbing();
    ctx.ui.setWidget("pi-sync", undefined);
    if (activeUi === ctx.ui) activeUi = null;
    if (handle) {
      const doc = await handle.doc?.();
      if (doc) {
        try {
          withSuppressedExport(() => {
            handle.change?.((d: PiConfigDocument) => {
              importAllFiles(d);
              d.lastSync[hostname] = Date.now();
            });
          });
        } catch {}
      }
    }
    if (event.reason === "quit" || event.reason === "reload") {
      await shutdownRepo();
    }
  });

  // ── Start syncing (or wait for takeover) ──────────────────────────

  if (await probePeer("localhost", config.port, 500)) {
    // Background watchdog — pi continues immediately, widget shows status
    watchAndTakeOver(pi).catch((e: any) =>
      console.error("[pi-sync] Watchdog failed:", e?.message ?? e),
    );
  } else {
    try {
      await initRepo(pi);
      startFileWatcher();
      startPurgeTimer();
    } catch (e: any) {
      console.error("[pi-sync] Failed to initialize sync repo:", e.message);
    }
  }
}
