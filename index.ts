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

import type { PeerId } from "@automerge/automerge-repo";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { installFooter } from "./footer";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type SyncedFile,
  type PiConfigDocument,
  type SyncConfig,
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
  fileKey as toFileKey,
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
  isDocEmpty,
  isTombstone,
  isPastTTL,
  partitionPendingChanges,
} from "./lib";

export type { SyncedFile, PiConfigDocument, SyncConfig };

import {
  hostname,
  WATCH_DEBOUNCE_MS,
  PURGE_INTERVAL_MS,
  REFRESH_ICON_DURATION_MS,
  RECENT_REMOTE_CHANGES_CAP,
  state,
} from "./state";

// ── Peer probing ─────────────────────────────────────────────────────

type NetModule = typeof import("node:net");

let netModulePromise: Promise<NetModule> | null = null;

function loadNet(): Promise<NetModule> {
  return (netModulePromise ??= import("node:net"));
}

function normalizeProbePort(port: number): number | null {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Quick TCP connect to check if a peer's sync port is reachable. */
async function probePeer(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  const safePort = normalizeProbePort(port);
  if (!host || safePort == null) return false;

  const net = await loadNet();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.destroy();
      resolve(ok);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    const onTimeout = () => finish(false);

    socket.setTimeout(Math.max(1, timeoutMs));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.unref?.();

    try {
      socket.connect(safePort, host);
    } catch {
      finish(false);
    }
  });
}

/** Bind probe for the local sync server port. Faster and more exact than TCP connect. */
async function canBindLocalPort(port: number): Promise<boolean> {
  const safePort = normalizeProbePort(port);
  if (safePort == null) return false;

  const net = await loadNet();
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (server.listening) {
        server.close(() => resolve(ok));
      } else {
        resolve(ok);
      }
    };
    const onError = () => finish(false);
    const onListening = () => finish(true);

    server.once("error", onError);
    server.once("listening", onListening);
    server.unref?.();

    try {
      server.listen({ port: safePort, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

/** TCP-probe all configured peers in parallel (best-effort reachability). */
async function probeAllPeers() {
  await Promise.allSettled(
    state.config.peers.map(async (peer) => {
      const parsed = parsePeer(peer);
      const host = parsed?.host ?? peerHost(peer);
      const port = parsed?.port ?? state.config.port;
      if (host === hostname) return;
      const ok = await probePeer(host, port);
      if (ok) state.tcpReachablePeers.add(host);
      else state.tcpReachablePeers.delete(host);
    }),
  );
}

function startProbing() {
  if (state.probeInterval) return;
  const runProbe = () => {
    void probeAllPeers().catch((e: any) =>
      console.error("[pi-sync] Peer probe failed:", e?.message ?? e),
    );
  };
  runProbe(); // immediate first probe
  state.probeInterval = setInterval(runProbe, 15_000); // every 15s
  (state.probeInterval as any).unref?.();
}
function stopProbing() {
  if (state.probeInterval) { clearInterval(state.probeInterval); state.probeInterval = null; }
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
  state.suppressExportDepth++;
  try {
    return fn();
  } finally {
    state.suppressExportDepth--;
  }
}

// ── Trash helpers ────────────────────────────────────────────────────

/** Move PI_DIR/<key> → TRASH_DIR/<key>. Overwrites any prior trash copy. */
function moveToTrash(fileKey: string): boolean {
  const src = piPathForKey(fileKey);
  if (!src) return false;
  if (!fs.existsSync(src)) return false;
  const dest = trashPathForKey(fileKey);
  if (!dest) return false;
  ensureDir(path.dirname(dest));
  try { fs.rmSync(dest, { force: true, recursive: true }); } catch {}
  fs.renameSync(src, dest);
  return true;
}

/** Move TRASH_DIR/<key> → PI_DIR/<key>. */
function restoreFromTrash(fileKey: string): boolean {
  const src = trashPathForKey(fileKey);
  if (!src) return false;
  if (!fs.existsSync(src)) return false;
  const dest = piPathForKey(fileKey);
  if (!dest) return false;
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
  return true;
}

function purgeFromTrash(fileKey: string) {
  const trashPath = trashPathForKey(fileKey);
  if (!trashPath) return;
  try { fs.rmSync(trashPath, { force: true }); } catch {}
}

function saveDocUrl(url: string) {
  // Atomic write: a crash mid-write here would leave an empty file and
  // the next start would treat us as un-paired, dropping doc identity.
  atomicWriteFile(DOC_URL_PATH, url);
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
  if (!shouldSync(key, state.config)) return false;
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
    content: state.ImmutableString ? new state.ImmutableString(content) : content,
    installedAt: existing?.installedAt ?? Date.now(),
  };
  if (existing?.source) entry.source = existing.source;
  collection[key] = entry;
  return true;
}

/** Collect all sync-eligible files under PI_DIR, returns fileKeys. */
function collectAllFiles(): string[] {
  const files: string[] = [];

  if (state.config.syncSettings && fs.existsSync(path.join(PI_DIR, "settings.json")))
    files.push("settings.json");
  if (state.config.syncModels && fs.existsSync(path.join(PI_DIR, "models.json")))
    files.push("models.json");

  const extDir = path.join(PI_DIR, "extensions");
  if (state.config.syncExtensions && fs.existsSync(extDir)) {
    files.push(...collectExtensionFiles(extDir, readEntries));
  }
  const skillsDir = path.join(PI_DIR, "skills");
  if (state.config.syncSkills && fs.existsSync(skillsDir)) {
    files.push(...collectSkillFiles(skillsDir, readEntries));
  }
  const promptsDir = path.join(PI_DIR, "prompts");
  if (state.config.syncPrompts && fs.existsSync(promptsDir)) {
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
  if (!shouldSync(key, state.config)) return false;

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
  // Track extension dirs that need a dependency check post-export
  const extMatch = key.match(/^extensions\/([^/]+)\//);
  if (extMatch) state.pendingInstalls.add(extMatch[1]);
  return true;
}

/** After exporting a batch of files, check any extension dirs that had
 *  files written. If the extension has a package.json with dependencies
 *  but no node_modules, run `npm install --ignore-scripts` so pi doesn't
 *  crash when loading the extension.
 *
 *  Fire-and-forget: `exec` (not `execSync`) so the Automerge change-
 *  handler path doesn't block the event loop for up to 60 s × N. Single
 *  in-flight guard on state so a /new triggering a parallel module load
 *  doesn't kick off a second installer for the same dir. */
async function installMissingExtensionDeps(): Promise<void> {
  if (state.installRunning) return;
  if (state.pendingInstalls.size === 0) return;
  state.installRunning = true;
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    // Drain on each pass — new entries can be added while we run, and the
    // outer loop picks them up before we release the in-flight flag.
    while (state.pendingInstalls.size > 0) {
      const batch = [...state.pendingInstalls];
      state.pendingInstalls.clear();
      for (const extName of batch) {
        const extDir = path.join(PI_DIR, "extensions", extName);
        const pkgPath = path.join(extDir, "package.json");
        const nmDir = path.join(extDir, "node_modules");
        try {
          if (!fs.existsSync(pkgPath)) continue;
          if (fs.existsSync(nmDir)) continue;
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;
          console.log(`[pi-sync] Installing deps for ${extName}…`);
          await execAsync("npm install --ignore-scripts", {
            cwd: extDir,
            timeout: 60_000,
          });
          console.log(`[pi-sync] Dependencies installed for ${extName}`);
        } catch (err: any) {
          console.error(
            `[pi-sync] Failed to install deps for ${extName}:`,
            err?.message ?? err,
          );
        }
      }
    }
  } finally {
    state.installRunning = false;
  }
}

function exportKeys(doc: PiConfigDocument, keys: Iterable<string>): boolean {
  state.exporting = true;
  try {
    let changed = false;
    for (const key of keys) {
      if (exportFile(doc, key)) changed = true;
    }
    // Fire-and-forget; runs npm install in the background so the change-
    // handler path returns immediately.
    void installMissingExtensionDeps();
    return changed;
  } finally {
    state.exporting = false;
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
  if (!state.handle || state.exporting) return;
  const files = [...state.pendingChanges];
  state.pendingChanges.clear();

  const currentDoc = await state.handle.doc?.();
  if (!currentDoc) return;

  const { present, deletions, blockedDeletions } = partitionPendingChanges(
    files,
    state.config,
    currentDoc,
    (key) => {
      const absPath = piPathForKey(key);
      return absPath != null && fs.existsSync(absPath);
    },
  );

  if (blockedDeletions) {
    // The user likely ran `rm -rf` / `git clean` / similar — better to
    // require them to restore the files and make a smaller deliberate
    // delete than silently wipe the cluster.
    console.error(
      `[pi-sync] Mass-delete brake: ${deletions.length} files vanished in one flush ` +
      `(limit ${MASS_DELETE_LIMIT}). No tombstones were created for those missing files. ` +
      `Restore them on disk, or restore and remove a smaller deliberate batch to propagate deletes.`,
    );
  }

  withSuppressedExport(() => {
    state.handle.change?.((doc: PiConfigDocument) => {
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
  if (state.watcher) return;
  try {
    state.watcher = fs.watch(PI_DIR, { recursive: true }, (_eventType, filename) => {
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
      const key = normalizeFileKey(toFileKey(absPath));
      if (!key || !shouldSync(key, state.config)) return;
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

      state.pendingChanges.add(key);
      if (state.watchTimer) clearTimeout(state.watchTimer);
      state.watchTimer = setTimeout(flushPendingChanges, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    console.error("[pi-sync] fs.watch failed:", err);
  }
}

function stopFileWatcher() {
  if (state.watchTimer) { clearTimeout(state.watchTimer); state.watchTimer = null; }
  if (state.watcher) { state.watcher.close(); state.watcher = null; }
}

// ── Tombstone TTL purge ──────────────────────────────────────────────

/** Find and hard-delete tombstones older than TOMBSTONE_TTL_MS. Trash
 *  files for those entries are removed too. Returns count purged. */
async function purgePastTTL(): Promise<number> {
  if (!state.handle) return 0;
  const doc = await state.handle.doc?.();
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
  state.handle.change?.((d: PiConfigDocument) => {
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
  if (state.purgeInterval) return;
  purgePastTTL().catch(() => {});
  state.purgeInterval = setInterval(() => { purgePastTTL().catch(() => {}); }, PURGE_INTERVAL_MS);
}

function stopPurgeTimer() {
  if (state.purgeInterval) { clearInterval(state.purgeInterval); state.purgeInterval = null; }
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

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  const s = String(e.code ?? e.message ?? err);
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE/.test(s);
}

/** Install a one-shot guard against Automerge wasm panics and network
 *  connection failures. Without this, a PatchLogMismatch or an
 *  ETIMEDOUT to an offline peer tears down the whole pi process.
 *  The guard keeps pi alive: for Automerge errors it quarantines
 *  storage and stops sync; for network errors it logs and continues
 *  without quarantine (peers coming/going is expected in P2P). */
function installCrashGuard() {
  if (state.crashGuardInstalled) return;
  state.crashGuardInstalled = true;

  const onCrash = (err: unknown, kind: "exception" | "rejection") => {
    const msg = (err as any)?.message ?? String(err);

    // Network connectivity errors — expected when peers go offline.
    // Log a warning, don't quarantine, don't shut down.
    if (isNetworkError(err)) {
      console.error(`[pi-sync] ${kind}: ${msg} (peer unreachable — not fatal)`);
      return;
    }

    if (!isAutomergeError(err)) {
      // Unknown error: log but don't re-throw (that would loop on
      // uncaughtException). We leave the process alive — better to
      // run with sync possibly broken than crash pi entirely.
      console.error(`[pi-sync] uncaught ${kind} (not automerge):`, err);
      return;
    }

    console.error(`[pi-sync] Automerge ${kind} caught:`, msg);
    const dest = quarantineStorage();
    void shutdownRepo().catch(() => {});
    const note =
      `pi-sync hit an Automerge crash and stopped.${dest ? `\nStorage quarantined → \`${dest}\`` : ""}\n` +
      `Run \`/reload\` to restart sync. If the crash recurs, run \`/sync:unlink\` and re-import from a peer.`;
    try { state.activeUi?.notify(note, "warning"); } catch {}
  };

  process.on("uncaughtException", (err) => onCrash(err, "exception"));
  process.on("unhandledRejection", (reason) => onCrash(reason, "rejection"));
}

async function initRepo(pi: ExtensionAPI): Promise<void> {
  // Synchronous guard set before any await — see SyncState.initInProgress.
  state.initInProgress = true;
  try {
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
  state.ImmutableString = IS;

  const { NodeWSServerAdapter, WebSocketClientAdapter } = netModule;

  // ── WebSocket server ──────────────────────────────────────────────

  state.wss = new WebSocketServer({ port: state.config.port });

  state.wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[pi-sync] Port ${state.config.port} is in use. ` +
        `Edit ~/.config/pi-sync/config.json to change.`
      );
    } else {
      console.error("[pi-sync] WS server error:", err.message);
    }
  });

  // Track real WS connections (inbound = another peer connected to us)
  state.wss.on("connection", (ws: any, req: any) => {
    const remoteAddr = req.socket?.remoteAddress || "unknown";
    const host = remoteAddr.replace(/^::ffff:/, "");
    state.wsConnectedPeers.set(host, { since: Date.now(), direction: "in" });
    ws.on("close", () => state.wsConnectedPeers.delete(host));
  });

  // ── Network adapters ──────────────────────────────────────────────

  const serverAdapter = new NodeWSServerAdapter(state.wss);
  const adapters: any[] = [serverAdapter];

  for (const peer of state.config.peers) {
    if (peerHost(peer) === hostname) continue;
    const adapter = new WebSocketClientAdapter(`ws://${peer}`);
    // Upstream bug: onError throws non-ECONNREFUSED errors (ETIMEDOUT,
    // ENOTFOUND, etc.) and disconnect() throws when the socket never
    // opened. Both become uncaught exceptions that pi's own handler
    // (process.prependListener) catches first and calls process.exit(1).
    // Wrap the instance methods to swallow these errors at the source.
    const origOnError = adapter.onError;
    adapter.onError = ((event: any) => {
      try { origOnError.call(adapter, event); }
      catch (err: any) { console.error(`[pi-sync] Connection error to ${peer}: ${err?.message ?? err}`); }
    }) as typeof adapter.onError;
    const origDisconnect = adapter.disconnect;
    adapter.disconnect = () => {
      try { origDisconnect.call(adapter); }
      catch (err: any) { console.error(`[pi-sync] Disconnect error for ${peer}: ${err?.message ?? err}`); }
    };
    adapters.push(adapter);
  }
  // Snapshot for the "edited since last reload" hint in /sync:status.
  state.peersAtInit = [...state.config.peers];

  // ── Create repo ───────────────────────────────────────────────────

  state.repo = new Repo({
    network: adapters,
    storage: new NodeFSStorageAdapter(AM_STORAGE),
    // PeerId is a branded string in @automerge/automerge-repo; the brand
    // is structural-only, no runtime tag, so the cast is safe.
    peerId: `pi-sync-${hostname}` as PeerId,
  });

  // ── Find or create document ───────────────────────────────────────

  const docUrl = loadDocUrl();

  if (docUrl) {
    // Joining an existing network — find the document, then push our
    // local state so other peers learn about any extensions/skills
    // this machine has that they don't know about yet.
    state.handle = await state.repo.find(docUrl);
  } else {
    // First run — create fresh document, then import files one at a time
    state.handle = state.repo.create({
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
    saveDocUrl(state.handle.url);

    // Import files incrementally to avoid WASM capacity overflow
    const files = collectAllFiles();
    for (const fileKey of files) {
      state.handle.change((doc: PiConfigDocument) => {
        importFile(doc, fileKey);
      });
    }
    console.log(`[pi-sync] Imported ${files.length} files into new document`);
  }

  // Attach the change listener BEFORE awaiting whenReady so we don't miss
  // patches, but gate exports on `state.initialSyncReady`. Without the gate,
  // each sync patch arriving mid-snapshot writes a partial tree to disk.
  state.handle.on?.("change", (payload: any) => {
    if (!state.initialSyncReady) return;
    const doc = payload?.doc;
    if (!doc) return;
    if (state.suppressExportDepth > 0) return;
    if (isDocEmpty(doc)) return;
    const patches: any[] = payload?.patches ?? [];

    // Track remote changes for the footer widget and /sync:status
    state.lastRemoteChangeTime = Date.now();
    if (patches.length === 0) {
      state.recentRemoteChanges = [];
      exportAllFiles(doc);
      return;
    }
    const dirty = dirtyKeysFromPatches(patches);
    // Deduplicate and cap: only add keys not already in
    // state.recentRemoteChanges, and drop oldest entries past the cap so
    // a long-running session doesn't grow the array unboundedly.
    for (const k of dirty) {
      if (state.recentRemoteChanges.includes(k)) continue;
      state.recentRemoteChanges.push(k);
      if (state.recentRemoteChanges.length > RECENT_REMOTE_CHANGES_CAP) {
        state.recentRemoteChanges.shift();
      }
    }
    exportKeys(doc, dirty);
  });

  // Wait for the doc to reach "ready" before doing any export work.
  // - Newly created docs (above) resolve immediately.
  // - Joining peers resolve once the initial snapshot is loaded.
  // If the join is interrupted (network drop, peer killed), whenReady
  // never resolves and nothing gets exported — disk stays clean.
  try {
    await state.handle.whenReady?.();
  } catch (err: any) {
    console.error("[pi-sync] handle never became ready:", err?.message ?? err);
    return;
  }

  const readyDoc = await state.handle.doc?.();
  if (readyDoc) {
    // Push our local files into the doc now that we know the full remote
    // state, so peers learn about anything we have that they don't.
    withSuppressedExport(() => {
      state.handle.change?.((doc: PiConfigDocument) => {
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
  state.initialSyncReady = true;
  } finally {
    state.initInProgress = false;
  }
}

async function shutdownRepo() {
  stopFileWatcher();
  stopProbing();
  stopPurgeTimer();
  // renderTimer is owned by the footer (started/stopped via setFooter
  // dispose); shutdownRepo intentionally doesn't touch it.
  state.wsConnectedPeers.clear();
  state.tcpReachablePeers.clear();
  state.initialSyncReady = false;
  if (state.repo) {
    try { await state.repo.shutdown?.(); } catch {}
  }
  if (state.wss) {
    try {
      // state.wss.close() only stops accepting new connections — existing
      // clients stay connected. Terminate them so the standby WebSocket
      // in watchAndTakeOver detects the close and can take over.
      for (const client of state.wss.clients) {
        try { client.terminate(); } catch {}
      }
      await new Promise<void>((resolve, reject) => {
        state.wss.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    } catch {}
    state.wss = null;
  }
  state.repo = null;
  state.handle = null;
}

// ── Watchdog: waits for the primary instance to exit, then takes over ─

async function waitForLocalSyncSocketClose(port: number): Promise<"closed" | "unreachable"> {
  const { default: WebSocket } = await import("ws");
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const ws = new WebSocket(`ws://localhost:${port}`);
    const finish = (result: "closed" | "unreachable") => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.once("open", () => { opened = true; });
    ws.once("close", () => finish(opened ? "closed" : "unreachable"));
    ws.once("error", () => finish(opened ? "closed" : "unreachable"));
  });
}

async function watchAndTakeOver(pi: ExtensionAPI) {
  state.standbyMode = true;
  const port = normalizeProbePort(state.config.port);
  if (port == null) {
    state.standbyMode = false;
    console.error(`[pi-sync] Invalid port ${state.config.port}. Edit ~/.config/pi-sync/config.json to change.`);
    return;
  }
  const waitResult = await waitForLocalSyncSocketClose(port);

  // Jitter: wait 50–500 ms before attempting to take over so multiple
  // standbys don't race for the port at the exact same instant.
  const jitterMs = Math.floor(Math.random() * 450) + 50;
  await new Promise((r) => setTimeout(r, jitterMs));

  // Did another standby already claim the port while we waited?
  if (!(await canBindLocalPort(port))) {
    if (waitResult === "unreachable") {
      state.standbyMode = false;
      console.error(
        `[pi-sync] Port ${port} is in use, but no pi-sync WebSocket responded. ` +
        `Edit ~/.config/pi-sync/config.json to change.`,
      );
      return;
    }
    console.log(
      `[pi-sync] Another instance took port ${state.config.port} — resuming standby`,
    );
    watchAndTakeOver(pi).catch((e: any) =>
      console.error("[pi-sync] Watchdog failed:", e?.message ?? e),
    );
    return;
  }

  state.standbyMode = false;
  await initRepo(pi);

  // Re-render the footer immediately after takeover so the TUI
  // layout re-flows and the footer line doesn't appear off by one.
  // (Otherwise the user waits up to 5 s for the next timer tick.)
  state.tuiRef?.requestRender();

  // Kick off the runtime loops that initRepo normally starts under the
  // non-standby path (watcher, probing, purge).
  startFileWatcher();
  startPurgeTimer();
  startProbing();
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  state.config = loadConfig();

  // Write default config if missing
  if (!fs.existsSync(CONFIG_PATH)) {
    atomicWriteFile(CONFIG_PATH, JSON.stringify(DEFAULT_SYNC_CONFIG, null, 2) + "\n");
  }

  // ── Commands (available immediately, before repo init) ────────────

  /** Write updated config to disk (atomic). */
  function saveConfig() {
    atomicWriteFile(CONFIG_PATH, JSON.stringify(state.config, null, 2) + "\n");
  }

  /** True when /sync:peers add|remove has edited the peer list since the
   *  running repo was constructed. The live WebSocket adapter set is
   *  frozen at initRepo time, so edits don't take effect until /reload. */
  function peersDivergedFromInit(): boolean {
    if (!state.handle) return false;
    if (state.peersAtInit.length !== state.config.peers.length) return true;
    const init = new Set(state.peersAtInit);
    for (const p of state.config.peers) if (!init.has(p)) return true;
    return false;
  }

  pi.registerCommand("sync:status", {
    description: "Show pi-sync status, peers, and sync toggles",
    handler: async (_args, ctx) => {
      const doc = state.handle ? await state.handle.doc?.() : undefined;
      const docUrl = loadDocUrl();
      const onOff = (b: boolean) => b ? "✅" : "❌";
      const lines = [
        `**pi-sync**  ─  \`${hostname}\`  :${state.config.port}`,
        ``,
        `Document: \`${docUrl ? docUrl.slice(0, 28) + "…" : "not set"}\``,
        `Peers (${state.config.peers.length}):`,
        ...(state.config.peers.length > 0
          ? state.config.peers.map((p) => {
              const h = peerHost(p);
              const mark = state.wsConnectedPeers.has(h) ? "🟢" : state.tcpReachablePeers.has(h) ? "🔵" : "🔴";
              const pending = state.peersAtInit.includes(p) ? "" : " _(pending /reload)_";
              return `  ${mark} \`${p}\`${pending}`;
            })
          : [`  _none configured — use \`/sync:peers add <host:port>\`_`]
        ),
        ...(peersDivergedFromInit() ? [`  _peer list edited since last reload — run \`/reload\` to apply_`] : []),
        ``,
        `Syncing: ${onOff(state.config.syncSettings)} settings  ${onOff(state.config.syncModels)} models  ${onOff(state.config.syncExtensions)} extensions  ${onOff(state.config.syncSkills)} skills  ${onOff(state.config.syncPrompts)} prompts`,
        ``,
        `Tracked: 🔌 ${Object.keys(doc?.extensions ?? {}).length} extensions  🔧 ${Object.keys(doc?.skills ?? {}).length} skills  ✏️ ${Object.keys(doc?.prompts ?? {}).length} prompts`,
        `Local-only: \`${Object.keys(doc?.localOnly ?? {}).length}\` entries`,
      ];

      // Recent remote changes
      if (state.recentRemoteChanges.length > 0 && Date.now() - state.lastRemoteChangeTime < REFRESH_ICON_DURATION_MS) {
        const ago = Math.round((Date.now() - state.lastRemoteChangeTime) / 1000);
        const agoStr = ago < 10 ? "just now" : `${ago}s ago`;
        lines.push(``);
        lines.push(`🔄 Last sync (${agoStr}) — ${state.recentRemoteChanges.length} change(s):`);
        for (const k of state.recentRemoteChanges.slice(0, 15)) {
          lines.push(`    \`${k}\``);
        }
        if (state.recentRemoteChanges.length > 15) {
          lines.push(`    … and ${state.recentRemoteChanges.length - 15} more`);
        }
      }

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
        if (state.config.peers.length === 0) {
          ctx.ui.notify(
            "No peers configured.\n\nAdd one: \`/sync:peers add laptop.tailnet.ts.net:3030\`\nAuto-discover: \`/sync:peers scan\`",
            "info",
          );
        } else {
          const list = state.config.peers.map((p) => {
            const h = peerHost(p);
            const mark = state.wsConnectedPeers.has(h) ? "🟢" : state.tcpReachablePeers.has(h) ? "🔵" : "🔴";
            return `  ${mark} \`${p}\``;
          }).join("\n");
          ctx.ui.notify(`**Peers (${state.config.peers.length}):**\n${list}\n\n🟢 WS-connected  🔵 TCP reachable  🔴 offline`, "info");
        }
        return;
      }

      if (action === "add" && target) {
        if (!target.includes(":")) {
          ctx.ui.notify("Format: \`host:port\` (e.g. \`laptop.tailnet.ts.net:3030\`)", "error");
          return;
        }
        if (state.config.peers.includes(target)) {
          ctx.ui.notify(`\`${target}\` is already in the peer list.`, "info");
          return;
        }
        if (peerHost(target) === hostname) {
          ctx.ui.notify("That's your own hostname — not adding self.", "info");
          return;
        }
        state.config.peers.push(target);
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
        const before = state.config.peers.length;
        state.config.peers = state.config.peers.filter(
          (p) => p !== target && peerHost(p) !== targetHost,
        );
        if (state.config.peers.length === before) {
          ctx.ui.notify(`Peer \`${target}\` not found.`, "info");
        } else {
          state.wsConnectedPeers.delete(targetHost);
          state.tcpReachablePeers.delete(targetHost);
          saveConfig();
          ctx.ui.notify(`Removed \`${target}\`. Run \`/reload\` to disconnect from the running session.`, "info");
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
                reachable: await probePeer(p.fqdn, state.config.port),
              })),
            );

          const syncPeers = probed.filter((p) => p.reachable);
          const nonSyncPeers = probed.filter((p) => !p.reachable);

          if (syncPeers.length === 0) {
            ctx.ui.notify(
              `Found ${probed.length} Tailscale peer(s), but none are running pi-sync on port ${state.config.port}.\n\n` +
              `Offline peers: ${nonSyncPeers.map((p) => `\`${p.host}\``).join(", ") || "none"}`,
              "info",
            );
            return;
          }

          const isConfigured = (host: string) =>
            state.config.peers.some((ep) => peerHost(ep) === host);
          const newSyncPeers = syncPeers.filter((p) => !isConfigured(p.host));
          const alreadyConfigured = syncPeers.filter((p) => isConfigured(p.host));

          if (alreadyConfigured.length > 0) {
            ctx.ui.notify(
              `Already configured:\n${alreadyConfigured.map((p) => `  ✅ \`${p.fqdn}:${state.config.port}\``).join("\n")}`,
              "info",
            );
          }

          if (newSyncPeers.length === 0) {
            if (alreadyConfigured.length === 0) {
              ctx.ui.notify("No new pi-sync peers to add.", "info");
            }
            return;
          }

          const peerOptions = newSyncPeers.map((p) => `${p.fqdn}:${state.config.port}`);
          const selection = await ctx.ui.select(
            `Found ${newSyncPeers.length} pi-sync peer(s). Select one to add:`,
            newSyncPeers.length > 1 ? ["Add all", ...peerOptions] : peerOptions,
          );

          if (selection) {
            const selectedPeers = selection === "Add all" ? peerOptions : [selection];
            for (const p of selectedPeers) {
              if (!state.config.peers.includes(p)) state.config.peers.push(p);
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
        { id: "syncSettings", label: "Settings", currentValue: state.config.syncSettings ? "on" : "off", values: ["on", "off"] },
        { id: "syncModels", label: "Models", currentValue: state.config.syncModels ? "on" : "off", values: ["on", "off"] },
        { id: "syncExtensions", label: "Extensions", currentValue: state.config.syncExtensions ? "on" : "off", values: ["on", "off"] },
        { id: "syncSkills", label: "Skills", currentValue: state.config.syncSkills ? "on" : "off", values: ["on", "off"] },
        { id: "syncPrompts", label: "Prompts", currentValue: state.config.syncPrompts ? "on" : "off", values: ["on", "off"] },
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
            // Only the boolean sync* toggles are exposed in buildItems();
            // port/peers aren't reachable from this panel.
            const key = id as "syncSettings" | "syncExtensions" | "syncSkills" | "syncModels" | "syncPrompts";
            state.config[key] = (newValue === "on");
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
      `2. \`/sync:peers add ${hostname}:${state.config.port}\``,
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
      state.config = loadConfig();
      try {
        await initRepo(pi);
        // After fresh init, restart runtime loops stopped during unlink.
        startFileWatcher();
        startPurgeTimer();
        startProbing();
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
      if (!state.handle) {
        ctx.ui.notify("pi-sync not initialized yet", "info");
        return;
      }
      const doc = await state.handle.doc?.();
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
        state.handle.change?.((d: PiConfigDocument) => {
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
          state.handle.change?.((d: PiConfigDocument) => {
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
      if (!state.handle) {
        ctx.ui.notify("pi-sync not initialized yet", "info");
        return;
      }
      const doc = await state.handle.doc?.();
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
        state.handle.change?.((d: PiConfigDocument) => {
          if (!d.localOnly[fileArg]) d.localOnly[fileArg] = [];
          if (!d.localOnly[fileArg].includes(targetHost)) {
            d.localOnly[fileArg].push(targetHost);
          }
        });
        ctx.ui.notify(`Marked \`${fileArg}\` as local-only for \`${targetHost}\``, "info");
        return;
      }

      if (action === "remove" && fileArg) {
        state.handle.change?.((d: PiConfigDocument) => {
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

  // ── Lifecycle ─────────────────────────────────────────────────────
  // Register these before init so they're always active (even when
  // waiting for takeover).

  pi.on("session_start", (_event, ctx) => {
    state.activeUi = ctx.ui;
    state.currentCtx = ctx;
    installFooter(ctx.ui);
    startSyncInBackground(pi);

    // No importAllFiles here: initRepo pushes local files during sync
    // startup, and the fs.watch loop catches any changes made while pi
    // is running. Re-importing on every /new churned through hundreds of
    // files just to short-circuit on syncedFileContentMatches.
    if (!state.handle) return;

    // Start health probing
    startProbing();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    stopProbing();
    ctx.ui.setFooter(undefined);
    state.currentCtx = null;
    state.tuiRef = null;
    if (state.activeUi === ctx.ui) state.activeUi = null;
    if (state.handle) {
      const doc = await state.handle.doc?.();
      if (doc) {
        try {
          withSuppressedExport(() => {
            state.handle.change?.((d: PiConfigDocument) => {
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
}

function startSyncInBackground(pi: ExtensionAPI) {
  // Re-entry guard: when pi reloads extensions inside the same process
  // (e.g. on `/new`), the module body re-executes against the singleton
  // `state` on globalThis. Three flags say "the previous instance still
  // owns this process":
  //   1. state.standbyMode — a watchAndTakeOver is already in flight,
  //      don't interfere (it will set state.standbyMode=false on takeover).
  //   2. state.handle — repo already initialized, port already bound.
  //   3. state.initInProgress — initRepo or the local port probe below
  //      is mid-flight; state.handle / state.standbyMode aren't observable
  //      yet but will be by the time this flag clears.
  // Without this, the local port probe below finds our own previous wss, calls
  // watchAndTakeOver, and we self-reenter standby forever.
  if (state.standbyMode || state.handle || state.initInProgress) return;

  void (async () => {
    // Mark sync so a parallel reload that lands inside the port probe await
    // (or before initRepo's own marker takes effect) sees us as in-progress
    // and bails out via the guard above.
    state.initInProgress = true;
    try {
      const port = normalizeProbePort(state.config.port);
      if (port == null) {
        console.error(`[pi-sync] Invalid port ${state.config.port}. Edit ~/.config/pi-sync/config.json to change.`);
        return;
      }

      if (!(await canBindLocalPort(port))) {
        // Background watchdog — pi continues immediately, widget shows status.
        // When the other instance exits it terminates all clients, causing
        // watchAndTakeOver's WebSocket to close and auto-take-over.
        // watchAndTakeOver's first synchronous step sets state.standbyMode,
        // so the guard takes over from initInProgress as soon as the .catch
        // below returns.
        watchAndTakeOver(pi).catch((e: any) =>
          console.error("[pi-sync] Watchdog failed:", e?.message ?? e),
        );
      } else {
        await initRepo(pi);
        startFileWatcher();
        startPurgeTimer();
        startProbing();
      }
    } catch (e: any) {
      console.error("[pi-sync] Failed to initialize sync repo:", e?.message ?? e);
    } finally {
      state.initInProgress = false;
    }
  })();
}
