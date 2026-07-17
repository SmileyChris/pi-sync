/**
 * pi-sync — P2P sync for pi coding agent config & session history
 *
 * Syncs six categories of files under ~/.pi/agent/ via Automerge CRDTs:
 * settings, models, extensions, skills, prompts, and sessions.
 * Full-mesh topology over WebSocket — every peer connects to every
 * other peer listed in ~/.config/pi-sync/config.json. No hub, no
 * primary. Works offline and merges automatically when reconnected.
 *
 * Session files are keyed as sessions/{source-hostname}/{cwd-dir}/…
 * so remote sessions land under a hostname directory on every peer,
 * clearly distinguishable from local sessions. pi-session-search
 * indexes them automatically via recursive .jsonl discovery.
 *
 * Debug log: ~/.local/state/pi-sync/debug.log
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
 *   /sync:prune-sessions – remove old session entries from the document
 *   /sync:local-only   – manage local-only files
 */

import type { PeerId } from "@automerge/automerge-repo";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { installFooter } from "./footer";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

// ── Debug logging ────────────────────────────────────────────────────
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
  STATE_DIR,
  DEBUG_LOG,
  TOMBSTONE_TTL_MS,
  MASS_DELETE_LIMIT,
  normalizeFileKey,
  fileKey as toFileKey,
  getSubdir,
  isLocalOnly,
  localOnlyHostsForKey,
  shouldSync,
  applyJsonMergeInPlace,
  applyJsonAdditionsInPlace,
  unwrapContent,
  syncedFileContentMatches,
  loadConfig as loadConfigFromFile,
  parsePeer,
  peerHost,
  collectExtensionFiles,
  collectSkillFiles,
  collectPromptFiles,
  collectSessionFiles,
  sessionKeyForLocalRelative,
  validateIncomingSessionKey,
  SESSIONS_DIR,
  dirtyKeysFromPatches,
  isDocEmpty,
  isTombstone,
  isPastTTL,
  partitionPendingChanges,
  effectivePeers,
  computeMeshPeerHosts,
} from "./lib";
import type { KnownPeer } from "./lib";

function debugLog(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    ensureDir(STATE_DIR);
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {}
}

/** Log to debug file AND show a TUI notification if a session is active.
 *  Prefer this over console.log so the message participates in the TUI
 *  layout rather than landing on stdout and displacing the editor. */
function notifyActive(
  message: string,
  type: "info" | "warning" | "error" = "info",
) {
  debugLog(message);
  try { state.activeUi?.notify(message, type); } catch {}
}

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
      debugLog(`Peer probe failed: ${e?.message ?? e}`),
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

/** Map a session doc key to the local filesystem path for import.
 *  Keys are sessions/{source-hostname}/{rest} but local files live at
 *  sessions/{rest} (without the hostname prefix). For our own hostname
 *  we strip the prefix; for remote hostnames the file was already
 *  written to the key path by a previous export. */
function sessionImportPath(key: string): string | null {
  const ourPrefix = `sessions/${hostname}/`;
  if (key.startsWith(ourPrefix)) {
    return piPathForKey(`sessions/${key.slice(ourPrefix.length)}`);
  }
  return piPathForKey(key);
}

function countTopDirs(collection: Record<string, unknown> | undefined): number {
  if (!collection) return 0;
  // Keys are "subdir/name/..." — count unique top-level names under the subdir
  return new Set(Object.keys(collection).map((k) => k.split("/")[1])).size;
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
  if (fs.existsSync(dest)) return false;
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

type LocalSyncBaseline = {
  documentUrl: string;
  trackedKeys: string[];
  updatedAt: number;
};

const LOCAL_BASELINE_PATH = path.join(CONFIG_DIR, "local-baseline.json");

function loadLocalBaseline(): LocalSyncBaseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_BASELINE_PATH, "utf-8"));
    if (
      typeof parsed?.documentUrl !== "string" ||
      !Array.isArray(parsed?.trackedKeys) ||
      !parsed.trackedKeys.every((key: unknown) => typeof key === "string")
    ) return null;
    return parsed as LocalSyncBaseline;
  } catch {
    return null;
  }
}

function trackedKeysForHost(doc: PiConfigDocument): string[] {
  const keys: string[] = [];
  for (const section of ["extensions", "skills", "prompts"] as const) {
    for (const [key, entry] of Object.entries(doc[section] ?? {})) {
      if (
        !isTombstone(entry) &&
        shouldSync(key, state.config) &&
        !localOnlyHostsForKey(doc.localOnly, key)
      ) keys.push(key);
    }
  }
  return keys.sort();
}

function saveLocalBaseline(doc: PiConfigDocument, documentUrl = loadDocUrl()) {
  if (!documentUrl) return;
  atomicWriteFile(LOCAL_BASELINE_PATH, JSON.stringify({
    documentUrl,
    trackedKeys: trackedKeysForHost(doc),
    updatedAt: Date.now(),
  } satisfies LocalSyncBaseline, null, 2) + "\n");
}

// ── Import: filesystem → document ─────────────────────────────────────

function importFile(
  doc: PiConfigDocument,
  fileKey: string,
  mode: "normal" | "additions-only" = "normal",
): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return false;
  const subdir = getSubdir(key);
  if (!subdir) return false;
  if (!shouldSync(key, state.config)) return false;
  // A local-only rule means content must not enter the shared Automerge
  // document, even on an allowed host. The allowlist controls which hosts may
  // retain a materialized disk copy, not who receives the shared document.
  if (localOnlyHostsForKey(doc.localOnly, key)) return false;

  const absPath = subdir === "sessions"
    ? sessionImportPath(key)
    : piPathForKey(key);
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
    return mode === "additions-only"
      ? applyJsonAdditionsInPlace(doc[subdir], content)
      : applyJsonMergeInPlace(doc[subdir], content);
  }

  // extensions | skills | prompts | sessions
  if (!doc[subdir]) (doc as Record<string, unknown>)[subdir] = {};
  const collection = doc[subdir] as Record<string, SyncedFile>;
  const existing = collection[key];
  if (mode === "additions-only" && existing) return false;
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

function importAllFiles(
  doc: PiConfigDocument,
  mode: "normal" | "additions-only" = "normal",
): boolean {
  let changed = false;
  for (const fileKey of collectAllFiles()) {
    if (importFile(doc, fileKey, mode)) changed = true;
  }
  return changed;
}

function enforceLocalOnlyOnDisk(doc: PiConfigDocument) {
  for (const key of collectAllFiles()) {
    const allowedHosts = localOnlyHostsForKey(doc.localOnly, key);
    if (!allowedHosts) continue;
    if (allowedHosts.includes(hostname)) restoreFromTrash(key);
    else moveToTrash(key);
  }
}

function removeLocalOnlyContentFromDoc(doc: PiConfigDocument): number {
  let removed = 0;
  for (const section of ["extensions", "skills", "prompts"] as const) {
    const collection = doc[section] as Record<string, SyncedFile>;
    for (const key of Object.keys(collection ?? {})) {
      if (localOnlyHostsForKey(doc.localOnly ?? {}, key)) {
        delete collection[key];
        removed++;
      }
    }
  }
  return removed;
}

// ── Export: document → filesystem ─────────────────────────────────────

function exportFile(doc: PiConfigDocument, fileKey: string): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return false;
  const localOnlyHosts = localOnlyHostsForKey(doc.localOnly, key);
  if (localOnlyHosts) {
    if (localOnlyHosts.includes(hostname)) {
      return restoreFromTrash(key);
    }
    return moveToTrash(key);
  }
  const subdir = getSubdir(key);
  if (!subdir) return false;
  if (!shouldSync(key, state.config)) return false;

  const absPath = piPathForKey(key);
  if (!absPath) return false;

  // Sessions: if the original source file (under --...-- dir) still
  // exists locally, skip export — this is our own session and it
  // already lives at its native path. Only export sessions that do
  // NOT have a local source (i.e. remote sessions from other peers).
  if (subdir === "sessions") {
    const sourcePath = sessionImportPath(key);
    if (sourcePath && sourcePath !== absPath && fs.existsSync(sourcePath))
      return false;
  }

  if (subdir === "settings" || subdir === "models") {
    const content = JSON.stringify(doc[subdir], null, 2) + "\n";
    if (readFileOrEmpty(absPath) === content) return false;
    atomicWriteFile(absPath, content);
    return true;
  }

  if (!doc[subdir]) return false;
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
          debugLog(`Installing deps for ${extName}…`);
          state.activeUi?.setStatus("pi-sync-install", `Installing deps for ${extName}…`);
          await execAsync("npm install --ignore-scripts", {
            cwd: extDir,
            timeout: 60_000,
          });
          state.activeUi?.setStatus("pi-sync-install", undefined);
          notifyActive(`Dependencies installed for ${extName}`, "info");
        } catch (err: any) {
          state.activeUi?.setStatus("pi-sync-install", undefined);
          notifyActive(
            `Failed to install deps for ${extName}: ${err?.message ?? err}`,
            "error",
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
    debugLog("Skipping export: document appears empty (first sync?)");
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
    const msg =
      `Mass-delete brake: ${deletions.length} files vanished in one flush ` +
      `(limit ${MASS_DELETE_LIMIT}). No tombstones were created for those missing files. ` +
      `Restore them on disk, or restore and remove a smaller deliberate batch to propagate deletes.`;
    notifyActive(msg, "warning");
  }

  withSuppressedExport(() => {
    state.handle.change?.((doc: PiConfigDocument) => {
      for (const key of present) {
        try {
          importFile(doc, key);
        } catch (err: any) {
          debugLog(`importFile failed for ${key}: ${err?.message ?? err}`);
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

// ── Session file sync (non-CRDT) ────────────────────────────────────

const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_BODY_BYTES = 64 * 1024 * 1024;
const SESSION_RETRY_MS = 15_000;

function sessionPeerAddresses(): string[] {
  const byHost = new Map<string, string>();
  for (const peer of state.config.peers) {
    const parsed = parsePeer(peer);
    if (parsed && parsed.host !== hostname) byHost.set(parsed.host, peer);
  }
  for (const host of state.meshPeerHosts) {
    if (host !== hostname && !byHost.has(host)) {
      byHost.set(host, `${host}:${state.config.port}`);
    }
  }
  return [...byHost.values()];
}

function scheduleSessionBroadcast(delayMs = 2000) {
  if (!state.config.syncSessions || state.sessionSyncTimer) return;
  state.sessionSyncTimer = setTimeout(() => {
    state.sessionSyncTimer = null;
    void broadcastPendingSessionFiles();
  }, delayMs);
  (state.sessionSyncTimer as any).unref?.();
}

function queueAllLocalSessionFiles() {
  if (!state.config.syncSessions || !fs.existsSync(SESSIONS_DIR)) return;
  for (const key of collectSessionFiles(SESSIONS_DIR, hostname, readEntries)) {
    state.pendingSessionChanges.add(key);
  }
  if (state.pendingSessionChanges.size > 0) scheduleSessionBroadcast(250);
}

/** Handle an incoming HTTP POST /session-sync request from a peer.
 *  Writes the session file to disk and suppresses re-broadcast. */
function handleSessionSyncRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!state.config.syncSessions) {
    res.writeHead(403);
    res.end("Session sync disabled");
    return;
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let rejected = false;
  req.on("data", (c: Buffer) => {
    receivedBytes += c.length;
    if (receivedBytes > MAX_SESSION_BODY_BYTES) {
      if (!rejected) {
        rejected = true;
        res.writeHead(413);
        res.end("Session payload too large");
      }
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (rejected) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof body?.key !== "string" || typeof body?.content !== "string") {
        res.writeHead(400);
        res.end("Invalid payload");
        return;
      }
      const key = validateIncomingSessionKey(body.key, hostname);
      if (!key) {
        res.writeHead(400);
        res.end("Invalid key");
        return;
      }
      if (Buffer.byteLength(body.content, "utf-8") > MAX_SESSION_FILE_BYTES) {
        res.writeHead(413);
        res.end("Session file too large");
        return;
      }
      const absPath = piPathForKey(key);
      if (!absPath) { res.writeHead(400); res.end(); return; }
      if (readFileOrEmpty(absPath) === body.content) {
        res.writeHead(204);
        res.end();
        return;
      }
      atomicWriteFile(absPath, body.content);
      debugLog(`session-sync: received ${key}`);
      res.writeHead(200);
      res.end("ok");
    } catch (e: any) {
      debugLog(`session-sync: receive error: ${e?.message ?? e}`);
      res.writeHead(500);
      res.end();
    }
  });
}

async function postSessionFile(peer: string, key: string, content: string): Promise<boolean> {
  const body = JSON.stringify({ key, content });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let request: http.ClientRequest;
    try {
      request = http.request(`http://${peer}/session-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (response) => {
        response.resume();
        finish((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300);
      });
    } catch {
      return finish(false);
    }
    request.setTimeout(5000, () => request.destroy(new Error("session sync timeout")));
    request.once("error", () => finish(false));
    request.end(body);
  });
}

/** Collect pending session changes and POST them to connected peers.
 *  Session files are sync'd file-by-file over HTTP (not Automerge)
 *  because they are append-only, hostname-namespaced, and don't need
 *  CRDT merging. */
async function broadcastPendingSessionFiles() {
  if (!state.config.syncSessions) {
    state.pendingSessionChanges.clear();
    return;
  }
  if (state.sessionBroadcastRunning) {
    scheduleSessionBroadcast();
    return;
  }
  if (state.pendingSessionChanges.size === 0) return;
  state.sessionBroadcastRunning = true;
  const changes = [...state.pendingSessionChanges];
  state.pendingSessionChanges.clear();

  try {
    const peers = sessionPeerAddresses();
    for (const key of changes) {
      const absPath = sessionImportPath(key);
      if (!absPath) continue;
      let content: string;
      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) continue;
        content = fs.readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }
      if (peers.length === 0) {
        state.pendingSessionChanges.add(key);
        continue;
      }
      const results = await Promise.all(peers.map((peer) => postSessionFile(peer, key, content)));
      if (results.some((ok) => !ok)) state.pendingSessionChanges.add(key);
    }
  } finally {
    state.sessionBroadcastRunning = false;
    if (state.pendingSessionChanges.size > 0) scheduleSessionBroadcast(SESSION_RETRY_MS);
  }
}

/** Watch for session file changes and broadcast them to peers. */
function startSessionSync() {
  if (!state.config.syncSessions) {
    debugLog(`session-sync: disabled by config`);
    return;
  }
  if (state.sessionWatcher) return;
  try {
    const sessionsDir = path.join(PI_DIR, "sessions");
    ensureDir(sessionsDir);
    state.sessionWatcher = fs.watch(sessionsDir, { recursive: true }, (_eventType, filename) => {
      if (typeof filename !== "string") return;
      const key = sessionKeyForLocalRelative(filename, hostname);
      if (!key) return;
      state.pendingSessionChanges.add(key);
      scheduleSessionBroadcast();
    });
    debugLog(`session-sync: watcher started on ${sessionsDir}`);
    queueAllLocalSessionFiles();
  } catch (err) {
    debugLog(`session-sync: watcher failed: ${err}`);
  }
}

function stopSessionSync() {
  if (state.sessionSyncTimer) { clearTimeout(state.sessionSyncTimer); state.sessionSyncTimer = null; }
  if (state.sessionWatcher) { state.sessionWatcher.close(); state.sessionWatcher = null; }
  state.pendingSessionChanges.clear();
  state.sessionBroadcastRunning = false;
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
    debugLog(`fs.watch failed: ${err}`);
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
  debugLog(`Purged ${purgeable.length} tombstone(s) past TTL`);
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
    debugLog(`Failed to quarantine storage: ${e?.message ?? e}`);
    return null;
  }
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  const s = String(e.code ?? e.message ?? err);
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE/.test(s);
}

/** Stub process.exit so pi's uncaughtException handler (which fires
 *  after ours) can't kill the process for a pi-sync error. Restored
 *  on the next tick so normal exits still work. */
let _stubRestoreTimer: ReturnType<typeof setTimeout> | null = null;
function stubProcessExit() {
  if ((process.exit as any)._stubbed) return; // already stubbed this cycle
  const origExit = process.exit;
  (process.exit as any) = ((code?: number) => {
    if ((process.exit as any)._stubbed) {
      debugLog(`Suppressed process.exit(${code})`);
      return undefined as never;
    }
    return origExit(code);
  }) as typeof process.exit;
  (process.exit as any)._stubbed = true;
  // Restore on next tick so Ctrl+C / quit / real errors can still exit
  if (_stubRestoreTimer) clearTimeout(_stubRestoreTimer);
  _stubRestoreTimer = setTimeout(() => {
    process.exit = origExit;
    _stubRestoreTimer = null;
  }, 0);
}

/** Install a guard against crashes from Automerge wasm panics and
 *  unreachable peers. Pi uses process.prependListener for its own
 *  uncaughtException handler which calls process.exit(1). We must
 *  also use prependListener to fire first. For recoverable errors
 *  we stub out process.exit so pi's handler can't kill the process
 *  for pi-sync errors (restored on next tick). */
function installCrashGuard() {
  if (state.crashGuardInstalled) return;
  state.crashGuardInstalled = true;

  const onCrash = (err: unknown, kind: "exception" | "rejection") => {
    const msg = (err as any)?.message ?? String(err);
    const stack = (err as any)?.stack ?? 'no stack';
    debugLog(`crash-guard: ${kind} fired — ${msg}`);
    debugLog(`crash-guard: stack: ${String(stack).split('\\n').slice(0, 5).join(' ← ')}`);

    // Network errors and ws disconnect-on-unopened-socket — both are
    // recoverable and expected when peers go offline. Prevent pi's
    // handler (which fires after ours) from calling process.exit(1).
    if (isNetworkError(err) || /WebSocket was closed before/.test(msg)) {
      debugLog(`crash-guard: recognized as recoverable, stubbing process.exit`);
      debugLog(`${kind}: ${msg} (not fatal)`);
      stubProcessExit();
      return;
    }

    if (!isAutomergeError(err)) {
      // Unknown error: let pi decide whether to crash. We don't stub
      // process.exit here — non-Automerge, non-network errors should
      // still surface to the user.
      debugLog(`uncaught ${kind}: ${String(err)}`);
      return;
    }

    debugLog(`Automerge ${kind} caught: ${msg}`);
    const dest = quarantineStorage();
    void shutdownRepo().catch(() => {});
    stubProcessExit();
    const note =
      `pi-sync hit an Automerge crash and stopped.${dest ? `\nStorage quarantined → \`${dest}\`` : ""}\n` +
      `Run \`/reload\` to restart sync. If the crash recurs, run \`/sync:unlink\` and re-import from a peer.`;
    try { state.activeUi?.notify(note, "warning"); } catch {}
  };

  process.prependListener("uncaughtException", (err) => onCrash(err, "exception"));
  process.prependListener("unhandledRejection", (reason) => onCrash(reason, "rejection"));
}

async function initRepo(pi: ExtensionAPI, saveConfig: () => void = () => {}): Promise<void> {
  debugLog(`initRepo: START, peers=${JSON.stringify(state.config.peers)}, hostname=${hostname}`);
  // Synchronous guard set before any await — see SyncState.initInProgress.
  state.initInProgress = true;
  try {
  ensureDir(CONFIG_DIR);
  ensureDir(AM_STORAGE);
  ensureDir(TRASH_DIR);

  installCrashGuard();

  // Yield to the event loop so the TUI can finish its initial paint
  // and process buffered user input before Automerge's 2.7 MB WASM
  // binary is loaded and compiled (which blocks the main thread
  // synchronously for 3-5 seconds when `import("@automerge/automerge-repo")`
  // evaluates the module and calls `new WebAssembly.Module()`).
  await new Promise<void>((resolve) => setImmediate(resolve));

  const t0 = Date.now();

  // Dynamic imports to avoid jiti/WASM top-level import issues
  const [{ WebSocketServer, default: WS }, { Repo, ImmutableString: IS }, { NodeFSStorageAdapter }, netModule] =
    await Promise.all([
      import("ws"),
      import("@automerge/automerge-repo"),
      import("@automerge/automerge-repo-storage-nodefs"),
      import("@automerge/automerge-repo-network-websocket"),
    ]);

  const t1 = Date.now();
  debugLog(`initRepo: dynamic imports took ${t1 - t0}ms (ws + automerge-repo + storage + network)`);

  // Monkey-patch net.Socket.prototype.connect to prevent raw TCP
  // errors from orphaned WebSocket connections. The adapter's retry
  // logic removes event listeners from the old WebSocket before
  // creating a new one, but never terminates the old socket. Each
  // orphaned TCP connection eventually times out (~2 min) and with
  // no listeners, Node.js throws uncaughtException.
  const _netModule = await import("node:net");
  const _origSocketConnect = _netModule.Socket.prototype.connect;
  const _peerTargets = new Set(state.config.peers.map((p) => {
    const parsed = parsePeer(p);
    const host = parsed?.host ?? peerHost(p);
    const port = parsed?.port ?? state.config.port;
    return `${host}:${port}`;
  }));
  _netModule.Socket.prototype.connect = function (this: any, ...args: any[]) {
    // Node.js internals can pass a pre-normalized arguments array as args[0]
    let normalizedArgs = args;
    if (args.length === 1 && Array.isArray(args[0])) {
      normalizedArgs = args[0];
    }
    const opts = typeof normalizedArgs[0] === "object" ? normalizedArgs[0] : null;
    let port = opts?.port ?? normalizedArgs[0];
    let host = opts?.host ?? normalizedArgs[1];
    // net.connect(options) stores host/port on the Socket and calls
    // connect() with no args — check this.host / this.port too.
    if (!host && this.host) host = this.host;
    if (!port && this.port) port = this.port;
    if (typeof host === "string" && port !== undefined) {
      const numericPort = Number(port);
      const targetKey = `${host}:${numericPort}`;
      if (_peerTargets.has(targetKey)) {
        debugLog(`net-patch: adding error listener for ${host}:${port}`);
        this.on("error", () => {});
      }
    }
    return _origSocketConnect.apply(this, args as any);
  };

  // Patch ws WebSocket.prototype.close to prevent uncaught exceptions
  // when closing a CONNECTING socket. The adapter's disconnect() removes
  // its error listener BEFORE calling close(), and ws asynchronously
  // emits 'error' via emitErrorAndClose when the underlying TCP
  // connection is aborted. With no listener, Node.js throws uncaught.
  // We add a no-op error listener before close() so the async error has
  // somewhere to go.
  // Apply ws prototype patch before any adapters are created
  debugLog(`initRepo: applying ws prototype close patch`);
  const _origWsClose = WS.prototype.close;
  WS.prototype.close = function (this: any, code?: number, reason?: Buffer) {
    if (this.readyState === WS.CONNECTING && this.listenerCount("error") === 0) {
      debugLog(`ws-close-patch: CONNECTING socket, 0 error listeners — adding no-op`);
      this.on("error", () => {});
    }
    return _origWsClose.call(this, code, reason);
  };

  // Store for use in importFile/exportFile
  state.ImmutableString = IS;

  const { NodeWSServerAdapter, WebSocketClientAdapter } = netModule;

  // Patch WebSocketClientAdapter.prototype.connect to close the old socket
  // and add a no-op error listener to it before it gets orphaned on reconnect.
  const _origAdapterConnect = WebSocketClientAdapter.prototype.connect;
  WebSocketClientAdapter.prototype.connect = function (this: any, peerId: any, peerMetadata: any) {
    if (this.socket) {
      debugLog(`adapter-connect-patch: closing old socket for ${this.url}`);
      try {
        this.socket.addEventListener("error", () => {});
        this.socket.close();
      } catch (err: any) {
        debugLog(`adapter-connect-patch: failed to close old socket: ${err?.message ?? err}`);
      }
    }
    return _origAdapterConnect.call(this, peerId, peerMetadata);
  };

  // ── HTTP server (routes WS upgrades + session sync) ───────────────
  // Share one TCP port: Automerge WebSocket on the default path,
  // session file sync via POST /session-sync. This avoids needing a
  // second port and keeps session files out of the Automerge CRDT.
  const httpServer = http.createServer((req, res) => {
    // Only handle POST /session-sync — everything else is WebSocket
    if (req.method === "POST" && req.url === "/session-sync") {
      handleSessionSyncRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  state.httpServer = httpServer;

  state.wss = new WebSocketServer({ noServer: true });
  state.wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      notifyActive(
        `Port ${state.config.port} is in use. ` +
        `Edit ~/.config/pi-sync/config.json to change.`,
        "error",
      );
    } else {
      debugLog(`WS server error: ${err.message}`);
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    state.wss.handleUpgrade(req, socket, head, (ws: any) => {
      state.wss.emit("connection", ws, req);
    });
  });
  httpServer.listen(state.config.port);
  debugLog(`initRepo: HTTP+WS server listening on port ${state.config.port}`);

  // Track connections via Automerge adapter events (not raw TCP) so we
  // capture both inbound and outbound peers under their real hostnames.
  // Also buffer peers that connect before the doc is ready — we flush
  // them into doc.knownPeers after whenReady resolves.
  const preReadyPeers = new Set<string>();
  const trackPeer = (peerId: PeerId, configPeerName?: string) => {
    const host = (peerId as string).replace(/^pi-sync-/, "");
    debugLog(`peer-candidate: ${host}${configPeerName ? ` (via config peer ${configPeerName})` : ""}`);
    state.wsConnectedPeers.set(host, { since: Date.now(), direction: "in" });
    // Add to meshPeerHosts synchronously so the footer updates immediately.
    // The change listener will recompute the full set when the doc write lands.
    state.meshPeerHosts.add(host);
    scheduleSessionBroadcast(100);
    // Record alias if the real host differs from the config peer name.
    // This lets us skip duplicate doc-known adapters on future reloads.
    if (configPeerName && host !== configPeerName) {
      if (state.config.peerAliases[host] !== configPeerName) {
        state.config.peerAliases[host] = configPeerName;
        saveConfig();
        debugLog(`peer-candidate: recorded alias ${host} → ${configPeerName}`);
      }
    }
    // Write to doc's knownPeers roster (shared mesh directory)
    if (state.handle) {
      state.handle.change?.((doc: PiConfigDocument) => {
        doc.knownPeers[host] = {
          lastSeen: Date.now(),
          addedBy: hostname,
        };
      });
    } else {
      preReadyPeers.add(host);
    }
  };
  const untrackPeer = (peerId: PeerId) => {
    const host = (peerId as string).replace(/^pi-sync-/, "");
    debugLog(`peer-disconnected: ${host}`);
    state.wsConnectedPeers.delete(host);
  };

  // ── Network adapters ──────────────────────────────────────────────

  const serverAdapter = new NodeWSServerAdapter(state.wss, 30_000);
  const adapters: any[] = [serverAdapter];

  for (const peer of state.config.peers) {
    if (peerHost(peer) === hostname) continue;
    debugLog(`initRepo: creating adapter for ${peer}, hostname=${hostname}`);
    const adapter = new WebSocketClientAdapter(`ws://${peer}`);
    // Upstream bug: onError throws non-ECONNREFUSED errors (ETIMEDOUT,
    // ENOTFOUND, etc.) and disconnect() throws when the socket never
    // opened. Both become uncaught exceptions that pi's own handler
    // (process.prependListener) catches first and calls process.exit(1).
    // Wrap the instance methods to swallow these errors at the source.
    const origOnError = adapter.onError;
    adapter.onError = ((event: any) => {
      const code = event?.error?.code || event?.code || '?';
      debugLog(`onError-wrapped: called for ${peer}, code=${code}`);
      try { origOnError.call(adapter, event); }
      catch (err: any) {
        debugLog(`onError-wrapped: CAUGHT throw for ${peer}: ${err?.message ?? err}`);
        debugLog(`Connection error to ${peer}: ${err?.message ?? err}`);
      }
    }) as typeof adapter.onError;
    const origDisconnect = adapter.disconnect;
    adapter.disconnect = () => {
      debugLog(`disconnect-wrapped: called for ${peer}`);
      try { origDisconnect.call(adapter); }
      catch (err: any) {
        debugLog(`disconnect-wrapped: CAUGHT for ${peer}: ${err?.message ?? err}`);
        debugLog(`Disconnect error for ${peer}: ${err?.message ?? err}`);
      }
      debugLog(`disconnect-wrapped: completed for ${peer}`);
    };
    // Track outbound connection state via adapter events
    const configHost = peerHost(peer);
    adapter.on("peer-candidate", ({ peerId }: { peerId: PeerId }) => trackPeer(peerId, configHost));
    adapter.on("peer-disconnected", ({ peerId }: { peerId: PeerId }) => untrackPeer(peerId));
    adapters.push(adapter);
  }
  // Track inbound connections via server adapter events
  serverAdapter.on("peer-candidate", ({ peerId }: { peerId: PeerId }) => trackPeer(peerId));
  serverAdapter.on("peer-disconnected", ({ peerId }: { peerId: PeerId }) => untrackPeer(peerId));

  // Snapshot for the "edited since last reload" hint in /sync:status.
  state.peersAtInit = [...state.config.peers];

  // ── Create repo ───────────────────────────────────────────────────

  state.repo = new Repo({
    network: adapters,
    storage: new NodeFSStorageAdapter(AM_STORAGE),
    peerId: `pi-sync-${hostname}` as PeerId,
  });
  debugLog(`initRepo: Repo created with ${adapters.length} adapters — connections starting`);

  // ── Find or create document ───────────────────────────────────────

  const docUrl = loadDocUrl();

  if (docUrl) {
    // Use findWithProgress instead of find() to avoid blocking the main
    // thread for 3-5 seconds. find() awaits synchronous WASM deserial-
    // ization of the ~44MB Automerge document. findWithProgress returns
    // a DocHandle immediately and loads the document asynchronously in
    // the background — the TUI stays responsive the whole time.
    const progress = state.repo.findWithProgress(docUrl);
    state.handle = progress.handle;
  } else {
    // First run — create fresh document, then import files one at a time
    state.handle = state.repo.create({
      settings: {},
      models: {},
      extensions: {},
      skills: {},
      prompts: {},
      knownPeers: {},
      localOnly: {
        // pi-sync extension must stay local — WASM binaries and peer
        // config are platform/machine-specific.
        "extensions/pi-sync": [hostname],
      },
      lastSync: {},
    });
    saveDocUrl(state.handle.url);

    // Yield before file collection so the TUI can finish its initial
    // paint before we walk the ~794MB agent directory tree.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Import files incrementally to avoid WASM capacity overflow
    const tCollect = Date.now();
    const files = collectAllFiles();
    debugLog(`initRepo: collectAllFiles found ${files.length} files in ${Date.now() - tCollect}ms`);
    const tImport = Date.now();
    for (const fileKey of files) {
      state.handle.change((doc: PiConfigDocument) => {
        importFile(doc, fileKey);
      });
    }
    debugLog(`initRepo: file imports took ${Date.now() - tImport}ms for ${files.length} files`);
    notifyActive(`Imported ${files.length} files into new sync document`, "info");
  }

  // Attach the change listener BEFORE awaiting whenReady so we don't miss
  // patches, but gate exports on `state.initialSyncReady`. Without the gate,
  // each sync patch arriving mid-snapshot writes a partial tree to disk.
  state.handle.on?.("change", (payload: any) => {
    if (!state.initialSyncReady) return;
    const doc = payload?.doc;
    if (!doc) return;
    if (state.suppressExportDepth > 0) return;
    const patches: any[] = payload?.patches ?? [];
    const localOnlyChanged = patches.some((p: any) => p.path[0] === "localOnly");
    if (isDocEmpty(doc) && !localOnlyChanged) return;

    // If knownPeers changed, refresh the mesh roster cache
    if (patches.length === 0 || patches.some((p: any) => p.path[0] === "knownPeers")) {
      state.meshPeerHosts = computeMeshPeerHosts(state.config.peers, doc.knownPeers, hostname, state.config.peerAliases);
    }

    // Track remote changes for the footer widget and /sync:status
    state.lastRemoteChangeTime = Date.now();
    if (patches.length === 0) {
      state.recentRemoteChanges = [];
      exportAllFiles(doc);
      enforceLocalOnlyOnDisk(doc);
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
    if (localOnlyChanged) enforceLocalOnlyOnDisk(doc);
  });

  if (docUrl) {
    // ── Find path: don't block — background continuation ───────────
    // DocHandle was returned from findWithProgress above. The document
    // is still loading (WASM deserialization). Defer the knownPeers
    // migration, whenReady, DNS loop, adapters, and file export to a
    // background async so the TUI stays responsive.
    void completeDocSetup(pi, preReadyPeers, docUrl);
  } else {
    // ── Create path: synchronous (fast — no WASM deserialization) ──
    state.handle.change?.((doc: PiConfigDocument) => {
      if (!doc.knownPeers) doc.knownPeers = {};
      if (!doc.localOnly) doc.localOnly = {};
      const removed = removeLocalOnlyContentFromDoc(doc);
      if (removed > 0) debugLog(`initRepo: removed ${removed} local-only entries from shared document`);
    });
    // No whenReady needed for newly created docs — already ready.
    // But call it for consistency; resolves immediately.
    await state.handle.whenReady?.();
    const readyDoc = await state.handle.doc?.();
    if (readyDoc) {
      withSuppressedExport(() => {
        state.handle.change?.((doc: PiConfigDocument) => {
          importAllFiles(doc);
          doc.lastSync[hostname] = Date.now();
        });
      });
      const createdDoc = (await state.handle.doc?.()) ?? readyDoc;
      if (!isDocEmpty(createdDoc)) {
        exportAllFiles(createdDoc);
      }
      enforceLocalOnlyOnDisk(createdDoc);
      saveLocalBaseline(createdDoc, state.handle.url);
    }
    state.initialSyncReady = true;
    debugLog(`initRepo: COMPLETE — ready for sync (create path)`);
  }
  } finally {
    state.initInProgress = false;
  }
}

async function shutdownRepo() {
  debugLog(`shutdownRepo: START`);
  stopFileWatcher();
  stopSessionSync();
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
  if (state.httpServer) {
    state.repo = null;
    state.handle = null;
    // Close the shared HTTP server (which stops the WS server too)
    try { state.httpServer.close(); } catch {}
    state.httpServer = null;
    state.wss = null;
    return;
  }
  // Legacy path (standalone wss before we added the http layer)
  // istanbul ignore next
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
    const timer = setTimeout(() => {
      finish(opened ? "closed" : "unreachable");
    }, 5000); // 5s watchdog timeout
    (timer as any).unref?.();

    const finish = (result: "closed" | "unreachable") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.once("open", () => { opened = true; });
    ws.once("close", () => finish(opened ? "closed" : "unreachable"));
    ws.once("error", () => finish(opened ? "closed" : "unreachable"));
  });
}

async function watchAndTakeOver(pi: ExtensionAPI, saveConfig: () => void = () => {}) {
  state.standbyMode = true;
  const port = normalizeProbePort(state.config.port);
  if (port == null) {
    state.standbyMode = false;
    notifyActive(`Invalid port ${state.config.port}. Edit ~/.config/pi-sync/config.json to change.`, "error");
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
      notifyActive(
        `Port ${port} is in use, but no pi-sync WebSocket responded. ` +
        `Edit ~/.config/pi-sync/config.json to change.`,
        "error",
      );
      return;
    }
    debugLog(
      `Another instance took port ${state.config.port} — resuming standby`,
    );
    watchAndTakeOver(pi, saveConfig).catch((e: any) =>
      debugLog(`Watchdog failed: ${e?.message ?? e}`),
    );
    return;
  }

  state.standbyMode = false;
  await initRepo(pi, saveConfig);

  // Re-render the footer immediately after takeover so the TUI
  // layout re-flows and the footer line doesn't appear off by one.
  // (Otherwise the user waits up to 5 s for the next timer tick.)
  state.tuiRef?.requestRender();

  // Kick off the runtime loops that initRepo normally starts under the
  // non-standby path (watcher, probing, purge).
  startFileWatcher();
  startSessionSync();
  startPurgeTimer();
  startProbing();
}

/** Background continuation for the findWithProgress path in initRepo.
 *  Runs after the TUI is already rendering. Waits for the Automerge
 *  document to finish loading (WASM deserialization), then completes
 *  the setup that couldn't run synchronously because the handle wasn't
 *  ready yet: knownPeers migration, whenReady, DNS/doc-known adapters,
 *  file import/export. Does NOT block the main thread — the TUI stays
 *  responsive throughout. */
async function completeDocSetup(
  pi: ExtensionAPI,
  preReadyPeers: Set<string>,
  documentUrl: string,
) {
  try {
    debugLog(`completeDocSetup: START — waiting for document to load...`);
    await state.handle.whenReady?.();
    debugLog(`completeDocSetup: whenReady resolved`);

    // Automatically prune stale session data from the CRDT document.
    // Sessions are now synced over HTTP (not CRDT), so any existing
    // session entries in the document are inert baggage. Removing them
    // shrinks the snapshot and speeds up future deserialization.
    state.handle.change?.((doc: PiConfigDocument) => {
      if (doc.sessions && Object.keys(doc.sessions).length > 0) {
        const count = Object.keys(doc.sessions).length;
        for (const key of Object.keys(doc.sessions)) {
          delete doc.sessions[key];
        }
        debugLog(`completeDocSetup: pruned ${count} stale session entries from CRDT`);
      }
    });

    // KnownPeers migration (safe now — handle is ready)
    state.handle.change?.((doc: PiConfigDocument) => {
      if (!doc.knownPeers) doc.knownPeers = {};
      if (!doc.localOnly) doc.localOnly = {};
      const removed = removeLocalOnlyContentFromDoc(doc);
      if (removed > 0) debugLog(`completeDocSetup: removed ${removed} local-only entries from shared document`);
    });

    const readyDoc = await state.handle.doc?.();

    // Flush buffered peers into doc.knownPeers
    if (readyDoc && preReadyPeers.size > 0) {
      state.handle.change?.((doc: PiConfigDocument) => {
        for (const host of preReadyPeers) {
          doc.knownPeers[host] = { lastSeen: Date.now(), addedBy: hostname };
        }
        preReadyPeers.clear();
      });
      state.meshPeerHosts = computeMeshPeerHosts(
        state.config.peers, readyDoc.knownPeers, hostname, state.config.peerAliases,
      );
    }

    // Doc-known adapters (DNS loop)
    if (readyDoc && state.repo?.networkSubsystem) {
      const existingHosts = new Set(state.config.peers.map((p) => peerHost(p)));
      for (const host of Object.keys(readyDoc.knownPeers || {})) {
        if (host === hostname || existingHosts.has(host)) continue;
        const alias = state.config.peerAliases[host];
        if (alias && existingHosts.has(alias)) {
          debugLog(`completeDocSetup: skipping doc-known adapter for ${host} (alias of config peer ${alias})`);
          continue;
        }
        try {
          await Promise.race([
            dns.promises.lookup(host),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`DNS timeout for ${host}`)), 2000),
            ),
          ]);
        } catch (dnsErr: any) {
          debugLog(`completeDocSetup: skipping doc-known adapter for ${host} (DNS: ${dnsErr?.code ?? dnsErr?.message ?? dnsErr})`);
          continue;
        }
        const { WebSocketClientAdapter: WSCA } = await import("@automerge/automerge-repo-network-websocket");
        const adapter = new WSCA(`ws://${host}:${state.config.port}`);
        const origOnError = (adapter as any).onError;
        (adapter as any).onError = ((event: any) => {
          try { origOnError.call(adapter, event); } catch {}
        }) as typeof origOnError;
        const origDisconnect = (adapter as any).disconnect;
        (adapter as any).disconnect = () => { try { origDisconnect.call(adapter); } catch {} };
        adapter.on("peer-candidate", ({ peerId }: { peerId: PeerId }) => {
          state.wsConnectedPeers.set((peerId as string).replace(/^pi-sync-/, ""), { since: Date.now(), direction: "in" });
          scheduleSessionBroadcast(100);
        });
        state.repo.networkSubsystem.addNetworkAdapter(adapter);
        debugLog(`completeDocSetup: doc-known adapter added for ${host}`);
      }
    }

    // A first join contributes only keys the established document does not
    // already contain. On later starts, the local baseline lets us safely
    // distinguish offline deletion from a file that never existed here.
    if (readyDoc) {
      const baseline = loadLocalBaseline();
      const firstJoin = baseline?.documentUrl !== documentUrl;
      const reconciliation = firstJoin
        ? { present: [], deletions: [], blockedDeletions: false }
        : partitionPendingChanges(
            baseline.trackedKeys,
            state.config,
            readyDoc,
            (key) => {
              const absPath = piPathForKey(key);
              return absPath != null && fs.existsSync(absPath);
            },
          );

      if (reconciliation.blockedDeletions) {
        notifyActive(
          `Startup mass-delete brake: ${reconciliation.deletions.length} previously tracked files are missing ` +
          `(limit ${MASS_DELETE_LIMIT}). No startup tombstones were created.`,
          "warning",
        );
      }

      withSuppressedExport(() => {
        state.handle.change?.((doc: PiConfigDocument) => {
          importAllFiles(doc, firstJoin ? "additions-only" : "normal");
          if (!reconciliation.blockedDeletions) {
            for (const key of reconciliation.deletions) {
              const section = getSubdir(key) as "extensions" | "skills" | "prompts";
              const entry = (doc[section] as Record<string, SyncedFile>)?.[key];
              if (entry && !isTombstone(entry)) {
                entry.deletedAt = Date.now();
                entry.deletedBy = hostname;
              }
            }
          }
          doc.lastSync[hostname] = Date.now();
        });
      });
      const mergedDoc = (await state.handle.doc?.()) ?? readyDoc;
      if (!isDocEmpty(mergedDoc)) {
        exportAllFiles(mergedDoc);
      }
      enforceLocalOnlyOnDisk(mergedDoc);
      saveLocalBaseline(mergedDoc, documentUrl);
      debugLog(`completeDocSetup: ${firstJoin ? "first join" : "restart"} merge completed`);
    }

    state.initialSyncReady = true;
    debugLog(`completeDocSetup: COMPLETE — sync is now active`);
  } catch (err: any) {
    notifyActive(`Document setup failed: ${err?.message ?? err}`, "error");
  }
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Allow disabling pi-sync without disabling all extensions.
  // Set PI_SYNC_DISABLED=1 env var or create ~/.config/pi-sync/disabled.
  if (process.env.PI_SYNC_DISABLED === "1" || fs.existsSync(path.join(CONFIG_DIR, "disabled"))) {
    debugLog("pi-sync disabled via env var or flag file");
    return;
  }

  // Pre-warm the heavy Automerge WASM imports at extension load time
  // (before session_start fires), so Node.js can resolve and cache
  // them asynchronously. By the time initRepo's await import(...)
  // runs, the modules are already evaluated and cached, turning the
  // ~100ms synchronous WASM compilation into ~2ms cache hit.
  void Promise.all([
    import("ws"),
    import("@automerge/automerge-repo"),
    import("@automerge/automerge-repo-storage-nodefs"),
    import("@automerge/automerge-repo-network-websocket"),
  ]).catch(() => {});

  state.config = loadConfig();

  // Seed meshPeerHosts from config (doc-known peers get layered in after init)
  state.meshPeerHosts = computeMeshPeerHosts(state.config.peers, undefined, hostname, state.config.peerAliases);

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
      const meshHosts = [...state.meshPeerHosts].sort();
      const lines = [
        `**pi-sync**  ─  \`${hostname}\`  :${state.config.port}`,
        ``,
        `Document: \`${docUrl ? docUrl.slice(0, 28) + "…" : "not set"}\``,
        `Peers (${meshHosts.length}):`,
        ...(meshHosts.length > 0
          ? meshHosts.map((h) => {
              const connected = state.wsConnectedPeers.has(h);
              const reachable = !connected && state.tcpReachablePeers.has(h);
              const mark = connected ? "🟢" : reachable ? "🔵" : "🔴";
              const isConfigSeed = state.config.peers.some((p) => peerHost(p) === h);
              const isDocPeer = doc?.knownPeers?.[h];
              const source = isConfigSeed && isDocPeer ? "config+mesh"
                : isConfigSeed ? "config seed"
                : "mesh roster";
              const peerStr = `${h}:${state.config.port}`;
              let tag = "";
              if (reachable) {
                tag = "attempting sync, ";
              }
              if (!connected) {
                if (isDocPeer?.lastSeen) {
                  const agoMs = Date.now() - isDocPeer.lastSeen;
                  const ago = agoMs < 60_000 ? `${Math.round(agoMs / 1000)}s`
                    : agoMs < 3_600_000 ? `${Math.round(agoMs / 60_000)}m`
                    : agoMs < 86_400_000 ? `${Math.round(agoMs / 3_600_000)}h`
                    : `${Math.round(agoMs / 86_400_000)}d`;
                  tag += `last seen ${ago} ago`;
                }
                const last = doc?.lastSync?.[h];
                if (last) {
                  const agoMs = Date.now() - last;
                  const ago = agoMs < 60_000 ? `${Math.round(agoMs / 1000)}s`
                    : agoMs < 3_600_000 ? `${Math.round(agoMs / 60_000)}m`
                    : agoMs < 86_400_000 ? `${Math.round(agoMs / 3_600_000)}h`
                    : `${Math.round(agoMs / 86_400_000)}d`;
                  tag += `last synced ${ago} ago`;
                }
              }
              if (tag) tag = ` (${tag})`;
              return `  ${mark} \`${peerStr}\`  _${source}_${tag}`;
            })
          : [`  _no peers — connect to get started_`]
        ),
        ...(peersDivergedFromInit() ? [`  _config peer list edited since last reload — run \`/reload\` to apply_`] : []),
        ``,
        `Syncing: ${onOff(state.config.syncSettings)} settings  ${onOff(state.config.syncModels)} models  ${onOff(state.config.syncExtensions)} extensions  ${onOff(state.config.syncSkills)} skills  ${onOff(state.config.syncPrompts)} prompts  ${onOff(state.config.syncSessions)} sessions`,
        ``,
        `Tracked: 🔌 ${countTopDirs(doc?.extensions)} extensions  🔧 ${countTopDirs(doc?.skills)} skills  ✏️ ${Object.keys(doc?.prompts ?? {}).length} prompts  📜 ${Object.keys(doc?.sessions ?? {}).length} sessions`,
        `Local-only: \`${Object.keys(doc?.localOnly ?? {}).length}\` entries`,
      ];

      // Recent remote changes
      if (state.recentRemoteChanges.length > 0) {
        const agoMs = Date.now() - state.lastRemoteChangeTime;
        const agoStr = agoMs < 60_000
          ? `${Math.round(agoMs / 1000)}s ago`
          : agoMs < 3_600_000
            ? `${Math.round(agoMs / 60_000)}m ago`
            : `${Math.round(agoMs / 3_600_000)}h ago`;
        lines.push(``);
        lines.push(`🔄 Last sync (${agoStr}) — ${state.recentRemoteChanges.length} change(s):`);
        for (const k of state.recentRemoteChanges.slice(0, 15)) {
          lines.push(`    \`${k}\``);
        }
        if (state.recentRemoteChanges.length > 15) {
          lines.push(`    … and ${state.recentRemoteChanges.length - 15} more`);
        }
      }

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const mdTheme = getMarkdownTheme();
        const md = new Markdown(lines.join("\n"), 1, 1, mdTheme);
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(md);
        container.addChild(new Text(theme.fg("dim", "any key to dismiss"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (_data: string) => done(undefined),
        };
      });
    },
  });

  pi.registerCommand("sync:peers", {
    description: "Manage peers: add, remove, list, scan",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const action = parts[0] || "list";
      const target = parts.slice(1).join(" ");

      if (action === "list" || action === "ls") {
        const meshHosts = [...state.meshPeerHosts].sort();
        const mdContent = meshHosts.length === 0
          ? "No peers in the mesh.\n\nAdd a seed: `/sync:peers add laptop.tailnet.ts.net:3030`\nAuto-discover: `/sync:peers scan`"
          : `**Peers (${meshHosts.length}):**\n` +
            meshHosts.map((h) => {
              const mark = state.wsConnectedPeers.has(h) ? "🟢" : state.tcpReachablePeers.has(h) ? "🔵" : "🔴";
              const isSeed = state.config.peers.some((p) => peerHost(p) === h);
              const note = isSeed ? " (config seed)" : " (mesh)";
              return `  ${mark} \`${h}:${state.config.port}\`${note}`;
            }).join("\n") +
            `\n\n🟢 WS-connected  🔵 TCP reachable  🔴 offline`;

        await ctx.ui.custom((_tui, theme, _kb, done) => {
          const mdTheme = getMarkdownTheme();
          const md = new Markdown(mdContent, 1, 1, mdTheme);
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(md);
          container.addChild(new Text(theme.fg("dim", "any key to dismiss"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (_data: string) => done(undefined),
          };
        });
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

        // Also write to doc.knownPeers so the full mesh learns about this peer
        const targetHost = peerHost(target);
        if (state.handle) {
          state.handle.change?.((doc: PiConfigDocument) => {
            doc.knownPeers[targetHost] = {
              lastSeen: Date.now(),
              addedBy: hostname,
            };
          });
          // Refresh meshPeerHosts from the live doc
          const liveDoc = await state.handle.doc?.();
          state.meshPeerHosts = computeMeshPeerHosts(state.config.peers, liveDoc?.knownPeers, hostname, state.config.peerAliases);
        }

        ctx.ui.notify(
          `Added peer \`${target}\`. Run \`/reload\` to connect.`,
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
          ctx.ui.notify(`Peer \`${target}\` not found in config.`, "info");
        } else {
          state.wsConnectedPeers.delete(targetHost);
          state.tcpReachablePeers.delete(targetHost);
          saveConfig();

          // Also remove from doc.knownPeers
          if (state.handle) {
            state.handle.change?.((doc: PiConfigDocument) => {
              delete doc.knownPeers[targetHost];
            });
            const liveDoc = await state.handle.doc?.();
            state.meshPeerHosts = computeMeshPeerHosts(state.config.peers, liveDoc?.knownPeers, hostname, state.config.peerAliases);
          }

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
        { id: "syncSessions", label: "Sessions", currentValue: state.config.syncSessions ? "on" : "off", values: ["on", "off"] },
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
            const key = id as "syncSettings" | "syncExtensions" | "syncSkills" | "syncModels" | "syncPrompts" | "syncSessions";
            state.config[key] = (newValue === "on");
            saveConfig();
            if (key === "syncSessions") {
              if (state.config.syncSessions) startSessionSync();
              else stopSessionSync();
            }
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
    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const mdTheme = getMarkdownTheme();
      const md = new Markdown(lines.join("\n"), 1, 1, mdTheme);
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(md);
      container.addChild(new Text(theme.fg("dim", "any key to dismiss"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (_data: string) => done(undefined),
      };
    });
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
        await initRepo(pi, saveConfig);
        // After fresh init, restart runtime loops stopped during unlink.
        startFileWatcher();
        startSessionSync();
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
      const localOnlySection = fileArg ? getSubdir(fileArg) : null;
      const isLocalOnlyCollection =
        localOnlySection === "extensions" ||
        localOnlySection === "skills" ||
        localOnlySection === "prompts";

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
        if (!isLocalOnlyCollection) {
          ctx.ui.notify("Local-only rules support extension, skill, and prompt paths.", "error");
          return;
        }
        const targetHost = parts[2] || hostname;
        state.handle.change?.((d: PiConfigDocument) => {
          if (!d.localOnly[fileArg]) d.localOnly[fileArg] = [];
          if (!d.localOnly[fileArg].includes(targetHost)) {
            d.localOnly[fileArg].push(targetHost);
          }
          // Remove current content from the shared document. Future imports are
          // blocked while the local-only rule exists.
          for (const section of ["extensions", "skills", "prompts"] as const) {
            const collection = d[section] as Record<string, SyncedFile>;
            for (const key of Object.keys(collection)) {
              if (key === fileArg || key.startsWith(`${fileArg}/`)) delete collection[key];
            }
          }
        });
        ctx.ui.notify(
          `Marked \`${fileArg}\` as local-only for \`${targetHost}\`. ` +
          "Its current content was removed from the shared document.",
          "info",
        );
        return;
      }

      if (action === "remove" && fileArg) {
        state.handle.change?.((d: PiConfigDocument) => {
          delete d.localOnly[fileArg];
          for (const key of collectAllFiles()) {
            if (key === fileArg || key.startsWith(`${fileArg}/`)) importFile(d, key);
          }
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

  pi.registerCommand("sync:prune-sessions", {
    description: "Remove old session entries from the CRDT document (preserves mesh)",
    handler: async (_args, ctx) => {
      if (!state.handle) {
        ctx.ui.notify("pi-sync not initialized yet", "info");
        return;
      }
      const doc = await state.handle.doc?.();
      if (!doc) {
        ctx.ui.notify("Document not ready yet", "info");
        return;
      }
      const sessionKeys = Object.keys(doc.sessions ?? {});
      if (sessionKeys.length === 0) {
        ctx.ui.notify("No session data in the CRDT document.", "info");
        return;
      }
      state.handle.change?.((d: PiConfigDocument) => {
        for (const key of sessionKeys) {
          delete d.sessions[key];
        }
      });
      ctx.ui.notify(
        `Pruned ${sessionKeys.length} session entries from the CRDT document. ` +
        `Peers will sync the deletion. Run /sync:status to confirm.`,
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
    startSyncInBackground(pi, saveConfig);

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
          const updatedDoc = (await state.handle.doc?.()) ?? doc;
          saveLocalBaseline(updatedDoc);
        } catch {}
      }
    }
    if (event.reason === "quit" || event.reason === "reload") {
      await shutdownRepo();
    }
  });
}

function startSyncInBackground(pi: ExtensionAPI, saveConfig: () => void = () => {}) {
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
        notifyActive(`Invalid port ${state.config.port}. Edit ~/.config/pi-sync/config.json to change.`, "error");
        return;
      }

      if (!(await canBindLocalPort(port))) {
        // Background watchdog — pi continues immediately, widget shows status.
        // When the other instance exits it terminates all clients, causing
        // watchAndTakeOver's WebSocket to close and auto-take-over.
        // watchAndTakeOver's first synchronous step sets state.standbyMode,
        // so the guard takes over from initInProgress as soon as the .catch
        // below returns.
        watchAndTakeOver(pi, saveConfig).catch((e: any) =>
          debugLog(`Watchdog failed: ${e?.message ?? e}`),
        );
      } else {
        // initRepo uses findWithProgress for the find-path — the
        // document handle is returned immediately without blocking.
        // The synchronous WASM document deserialization runs in a
        // background continuation (completeDocSetup). The TUI stays
        // responsive throughout.
        await initRepo(pi, saveConfig);
        startFileWatcher();
        startSessionSync();
        startPurgeTimer();
        startProbing();
      }
    } catch (e: any) {
      notifyActive(`Failed to initialize sync repo: ${e?.message ?? e}`, "error");
    } finally {
      state.initInProgress = false;
    }
  })();
}
