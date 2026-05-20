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
 *   /sync:info         – show your document URL (share this to pair)
 *   /sync:invite       – alias for /sync:info
 *   /sync:import <url> – join an existing sync network
 *   /sync:unlink       – detach from the sync network
 *   /sync:peers        – manage peer list (add/remove/list/scan)
 *   /sync:config       – interactive settings panel (toggle sync categories)
 *   /sync:local-only   – manage local-only files
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Types (no external imports needed at top level)
export interface SyncedFile {
  content: string;
  installedAt: number;
  source?: string;
}

export interface PiConfigDocument {
  settings: Record<string, unknown>;
  models: Record<string, unknown>;
  extensions: Record<string, SyncedFile>;
  skills: Record<string, SyncedFile>;
  prompts: Record<string, SyncedFile>;
  localOnly: Record<string, string[]>;
  lastSync: Record<string, number>;
}

export interface SyncConfig {
  port: number;
  peers: string[];
  syncSettings: boolean;
  syncExtensions: boolean;
  syncSkills: boolean;
  syncModels: boolean;
  syncPrompts: boolean;
}

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  port: 3030,
  peers: [],
  syncSettings: true,
  syncExtensions: true,
  syncSkills: true,
  syncModels: true,
  syncPrompts: true,
};

// Paths
const home = os.homedir();
const PI_DIR = path.join(home, ".pi", "agent");
const CONFIG_DIR = path.join(home, ".config", "pi-sync");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DOC_URL_PATH = path.join(CONFIG_DIR, "doc-url");
const AM_STORAGE = path.join(home, ".pi", "am-storage");

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
const clientAdapters = new Map<string, any>(); // peerHost → adapter

// Export guard: prevent fs.watch from re-importing files while we're writing them
let exporting = false;

// Debounce
let pendingChanges = new Set<string>();
let watchTimer: ReturnType<typeof setTimeout> | null = null;
const WATCH_DEBOUNCE_MS = 500;

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

/** TCP-probe all configured peers (best-effort reachability check) */
async function probeAllPeers() {
  for (const peer of config.peers) {
    const [host, portStr] = peer.split(":");
    const port = parseInt(portStr) || config.port;
    if (host === hostname) continue;
    const ok = await probePeer(host, port);
    if (ok) {
      tcpReachablePeers.add(host);
    } else {
      tcpReachablePeers.delete(host);
    }
  }
}

let probeInterval: ReturnType<typeof setInterval> | null = null;
function startProbing() {
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

function loadConfig(): SyncConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_SYNC_CONFIG, ...raw };
    }
  } catch {}
  return { ...DEFAULT_SYNC_CONFIG };
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

function fileKey(filePath: string): string {
  return path.relative(PI_DIR, filePath);
}

function getSubdir(fileKey: string): string | null {
  if (fileKey === "settings.json") return "settings";
  if (fileKey === "models.json") return "models";
  if (fileKey.startsWith("extensions/") || fileKey.startsWith("extensions\\")) return "extensions";
  if (fileKey.startsWith("skills/") || fileKey.startsWith("skills\\")) return "skills";
  if (fileKey.startsWith("prompts/") || fileKey.startsWith("prompts\\")) return "prompts";
  return null;
}

function isLocalOnlyByMap(
  localOnly: Record<string, string[]>,
  fileKey: string,
): boolean {
  const allowed = localOnly[fileKey];
  if (!allowed) return false;
  return !allowed.includes(hostname);
}

function isLocalOnly(doc: PiConfigDocument | undefined, fileKey: string): boolean {
  if (!doc) return false;
  return isLocalOnlyByMap(doc.localOnly, fileKey);
}

// ── Import: filesystem → document ─────────────────────────────────────

function importFile(doc: PiConfigDocument, fileKey: string): boolean {
  const absPath = path.join(PI_DIR, fileKey);
  if (!fs.existsSync(absPath)) return false;
  const content = fs.readFileSync(absPath, "utf-8");
  const subdir = getSubdir(fileKey);
  if (!subdir) return false;

  if (isLocalOnlyByMap(doc.localOnly, fileKey)) return false;

  if (subdir === "settings") {
    try {
      const parsed = JSON.parse(content);
      // Per-key merge to preserve CRDT semantics — avoids whole-object
      // replacement which would lose concurrent changes to other keys.
      const existing = doc.settings || {};
      let hasDiff = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (JSON.stringify(existing[k]) !== JSON.stringify(v)) { hasDiff = true; break; }
      }
      // Also check for removed keys
      for (const k of Object.keys(existing)) {
        if (!(k in parsed)) { hasDiff = true; break; }
      }
      if (!hasDiff) return false;
      // Remove keys no longer present, then set all current keys
      for (const k of Object.keys(existing)) {
        if (!(k in parsed)) delete doc.settings[k];
      }
      for (const [k, v] of Object.entries(parsed)) {
        doc.settings[k] = v;
      }
      return true;
    } catch { return false; }
  }
  if (subdir === "models") {
    try {
      const parsed = JSON.parse(content);
      const existing = doc.models || {};
      let hasDiff = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (JSON.stringify(existing[k]) !== JSON.stringify(v)) { hasDiff = true; break; }
      }
      for (const k of Object.keys(existing)) {
        if (!(k in parsed)) { hasDiff = true; break; }
      }
      if (!hasDiff) return false;
      for (const k of Object.keys(existing)) {
        if (!(k in parsed)) delete doc.models[k];
      }
      for (const [k, v] of Object.entries(parsed)) {
        doc.models[k] = v;
      }
      return true;
    } catch { return false; }
  }
  if (subdir === "extensions" || subdir === "skills" || subdir === "prompts") {
    const collection = doc[subdir] as Record<string, SyncedFile>;
    const existing = collection[fileKey];

    // ImmutableString unwrap: doc proxy may return ImmutableString { val }
    const existingContent = typeof existing?.content === 'string'
      ? existing.content
      : (existing?.content?.val ?? null);
    if (existingContent === content) return false;

    const entry: SyncedFile = {
      content: ImmutableString ? new ImmutableString(content) : content,
      installedAt: existing?.installedAt ?? Date.now(),
    };
    if (existing?.source) entry.source = existing.source;
    collection[fileKey] = entry;
    return true;
  }
  return false;
}

/** Collect all files that need importing, returns array of fileKeys */
function collectAllFiles(): string[] {
  const files: string[] = [];

  // Settings & models
  if (config.syncSettings && fs.existsSync(path.join(PI_DIR, "settings.json")))
    files.push("settings.json");
  if (config.syncModels && fs.existsSync(path.join(PI_DIR, "models.json")))
    files.push("models.json");

  // Extensions — sync code + assets (skip pi-sync itself; it's local-only)
  if (config.syncExtensions) {
    const extDir = path.join(PI_DIR, "extensions");
    if (fs.existsSync(extDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== "pi-sync" && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(fullPath);
          } else if (
            entry.name.endsWith(".ts") || entry.name.endsWith(".js") ||
            entry.name.endsWith(".css") || entry.name.endsWith(".json") ||
            entry.name.endsWith(".wasm") || entry.name.endsWith(".html") ||
            entry.name.endsWith(".svg") || entry.name.endsWith(".png") ||
            entry.name.endsWith(".jpg") || entry.name.endsWith(".woff2") ||
            entry.name.endsWith(".md")
          ) {
            files.push(fileKey(fullPath));
          }
        }
      };
      walk(extDir);
    }
  }

  // Skills
  if (config.syncSkills) {
    const skillsDir = path.join(PI_DIR, "skills");
    if (fs.existsSync(skillsDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(fullPath);
          } else if (entry.name === "SKILL.md" || entry.name.endsWith(".md")) {
            files.push(fileKey(fullPath));
          }
        }
      };
      walk(skillsDir);
    }
  }

  // Prompts
  if (config.syncPrompts) {
    const promptsDir = path.join(PI_DIR, "prompts");
    if (fs.existsSync(promptsDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(fullPath);
          } else if (entry.name.endsWith(".md") || entry.name.endsWith(".txt")) {
            files.push(fileKey(fullPath));
          }
        }
      };
      walk(promptsDir);
    }
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
  if (isLocalOnly(doc, fileKey)) return false;

  const absPath = path.join(PI_DIR, fileKey);
  const subdir = getSubdir(fileKey);
  if (!subdir) return false;

  if (subdir === "settings") {
    if (!config.syncSettings) return false;
    const content = JSON.stringify(doc.settings, null, 2) + "\n";
    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
    if (existing === content) return false;
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, content);
    return true;
  }

  if (subdir === "models") {
    if (!config.syncModels) return false;
    const content = JSON.stringify(doc.models, null, 2) + "\n";
    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
    if (existing === content) return false;
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, content);
    return true;
  }

  if (subdir === "extensions" || subdir === "skills" || subdir === "prompts") {
    if (subdir === "extensions" && !config.syncExtensions) return false;
    if (subdir === "skills" && !config.syncSkills) return false;
    if (subdir === "prompts" && !config.syncPrompts) return false;

    const collection = doc[subdir] as Record<string, SyncedFile>;
    const synced = collection[fileKey];
    if (!synced) return false;

    // Unwrap ImmutableString: doc proxy may return { val: "..." }
    const syncedContent = typeof synced.content === 'string'
      ? synced.content
      : (synced.content?.val ?? "");

    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
    if (existing === syncedContent) return false;

    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, syncedContent);
    return true;
  }

  return false;
}

function exportAllFiles(doc: PiConfigDocument): boolean {
  // Guard: prevent watcher from re-importing files we're writing now
  exporting = true;
  try {
    // Safety: don't export from a seemingly empty/uninitialized document
    const extCount = Object.keys(doc.extensions).length;
    const skillCount = Object.keys(doc.skills).length;
    const settingCount = Object.keys(doc.settings).length;
    if (extCount === 0 && skillCount === 0 && settingCount === 0) {
      console.log("[pi-sync] Skipping export: document appears empty (first sync?)");
      return false;
    }
    let changed = false;
    if (exportFile(doc, "settings.json")) changed = true;
    if (exportFile(doc, "models.json")) changed = true;

    if (config.syncExtensions) {
      for (const key of Object.keys(doc.extensions)) {
        if (exportFile(doc, key)) changed = true;
      }
    }
    if (config.syncSkills) {
      for (const key of Object.keys(doc.skills)) {
        if (exportFile(doc, key)) changed = true;
      }
    }
    if (config.syncPrompts) {
      for (const key of Object.keys(doc.prompts)) {
        if (exportFile(doc, key)) changed = true;
      }
    }
    return changed;
  } finally {
    exporting = false;
  }
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

  handle.change?.((doc: PiConfigDocument) => {
    for (const fileKey of files) {
      importFile(doc, fileKey);
    }
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
        filename.startsWith(".obgo")
      ) return;

      const key = fileKey(path.join(PI_DIR, filename));
      const subdir = getSubdir(key);
      if (!subdir) return;

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

// ── Repo lifecycle ────────────────────────────────────────────────────

async function initRepo(pi: ExtensionAPI): Promise<void> {
  ensureDir(CONFIG_DIR);
  ensureDir(AM_STORAGE);

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
    const peerHost = remoteAddr.replace(/^::ffff:/, "");
    wsConnectedPeers.set(peerHost, { since: Date.now(), direction: "in" });
    ws.on("close", () => wsConnectedPeers.delete(peerHost));
  });

  // ── Network adapters ──────────────────────────────────────────────

  const serverAdapter = new NodeWSServerAdapter(wss);
  clientAdapters.clear();
  const adapters: any[] = [serverAdapter];

  for (const peer of config.peers) {
    const [peerHost] = peer.split(":");
    if (peerHost === hostname) continue;
    const adapter = new WebSocketClientAdapter(`ws://${peer}`);
    clientAdapters.set(peerHost, adapter);
    adapters.push(adapter);
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
    handle = repo.find(docUrl);
    handle.change?.((doc: PiConfigDocument) => {
      importAllFiles(doc);
      doc.lastSync[hostname] = Date.now();
    });
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
    handle.change((doc: PiConfigDocument) => {
      doc.lastSync[hostname] = Date.now();
    });
    console.log(`[pi-sync] Imported ${files.length} files into new document`);
  }

  // Listen for changes from other peers — when a remote peer pushes a
  // change, export it to our local filesystem. We also mark outbound
  // peers as WS-connected when we receive data from them (a stronger
  // signal than TCP probing alone).
  handle.on?.("change", ({ handle: changed }: any) => {
    const doc = changed.doc?.();
    if (!doc) return;
    // Track last sync activity per peer (best-effort — the Automerge
    // change event doesn't expose which peer sent it, but we can at
    // least record that sync is flowing from the network).
    exportAllFiles(doc);
  });

  // Periodically refresh WS-health for outbound peers via the repo's
  // own network state. Outbound adapters managed by Automerge may go
  // stale without us noticing; we log a warning if configured peers
  // have no recent activity.
  setInterval(() => {
    if (!repo) return;
    for (const [peerHost, adapter] of clientAdapters) {
      // If the peer shows in wsConnectedPeers, sync is healthy.
      // Otherwise check if it's at least TCP-reachable as a hint.
      if (!wsConnectedPeers.has(peerHost) && !tcpReachablePeers.has(peerHost)) {
        // Completely offline — expected if the peer machine is off.
        // No log spam needed here.
      }
    }
  }, 30_000);
}

async function shutdownRepo() {
  stopFileWatcher();
  wsConnectedPeers.clear();
  tcpReachablePeers.clear();
  if (wss) {
    try { wss.close?.(); } catch {}
    wss = null;
  }
  repo = null;
  handle = null;
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
              const h = p.split(":")[0];
              const mark = wsConnectedPeers.has(h) ? "🟢" : tcpReachablePeers.has(h) ? "🔵" : "🔴";
              return `  ${mark} \`${p}\``;
            })
          : [`  _none configured — use \`/sync:peers add <host:port>\`_`]
        ),
        ``,
        `Syncing: ${onOff(config.syncSettings)} settings  ${onOff(config.syncModels)} models  ${onOff(config.syncExtensions)} extensions  ${onOff(config.syncSkills)} skills  ${onOff(config.syncPrompts)} prompts`,
        ``,
        `Tracked: \`${Object.keys(doc?.extensions ?? {}).length}\` extensions, \`${Object.keys(doc?.skills ?? {}).length}\` skills, \`${Object.keys(doc?.prompts ?? {}).length}\` prompts`,
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
            const h = p.split(":")[0];
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
        // Don't add self
        const [peerHost] = target.split(":");
        if (peerHost === hostname) {
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
        const before = config.peers.length;
        config.peers = config.peers.filter((p) => !p.startsWith(target));
        if (config.peers.length === before) {
          ctx.ui.notify(`Peer \`${target}\` not found.`, "info");
        } else {
          // Clean up tracking state for the removed peer
          const [peerHost] = target.split(":");
          wsConnectedPeers.delete(peerHost);
          tcpReachablePeers.delete(peerHost);
          clientAdapters.delete(peerHost);
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

          // Probe each to check if pi-sync is running
          const probed: { host: string; fqdn: string; reachable: boolean }[] = [];
          for (const p of tailscalePeers) {
            const ok = await probePeer(p.fqdn, config.port);
            probed.push({ ...p, reachable: ok });
          }

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

          const newSyncPeers = syncPeers.filter(
            (p) => !config.peers.some((ep) => ep.startsWith(p.host)),
          );
          const alreadyConfigured = syncPeers.filter((p) =>
            config.peers.some((ep) => ep.startsWith(p.host)),
          );

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

          const peerOptions = newSyncPeers.map((p) => ({
            value: `${p.fqdn}:${config.port}`,
            label: `${p.host}  →  ${p.fqdn}:${config.port}`,
          }));

          const selections = await ctx.ui.select(
            `Found ${newSyncPeers.length} pi-sync peer(s). Select to add:`,
            peerOptions,
          );

          if (selections && selections.length > 0) {
            for (const p of selections as string[]) {
              if (!config.peers.includes(p)) config.peers.push(p);
            }
            saveConfig();
            ctx.ui.notify(
              `Added ${selections.length} peer(s). Run \`/reload\` to connect.`,
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

  pi.registerCommand("sync:info", {
    description: "Show invite key and instructions for pairing machines",
    handler: async (_args, ctx) => {
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
        `1. Install pi-sync: same setup as this machine`,
        `2. \`/sync:peers add ${hostname}:${config.port}\``,
        `3. \`/sync:import ${docUrl}\``,
        `4. \`/reload\``,
        ``,
        `They'll automatically pull all synced extensions and skills.`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Alias for /sync:info
  pi.registerCommand("sync:invite", {
    description: "Show invite key for pairing a new machine",
    handler: async (_args, ctx) => {
      const docUrl = loadDocUrl();
      if (!docUrl) {
        ctx.ui.notify("No document yet — waiting for repo to initialize.", "info");
        return;
      }
      const lines = [
        `**pi-sync invite**`,
        ``,
        `Your join key:`,
        ``,
        `\`${docUrl}\``,
        ``,
        `**On the other machine:**`,
        `1. Install pi-sync (clone extension dir + npm install)`,
        `2. \`/sync:peers add ${hostname}:${config.port}\``,
        `3. \`/sync:import ${docUrl}\` then \`/reload\``,
        ``,
        `They'll pull all synced config, extensions, and skills.`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
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
        // After fresh init, start the watcher
        startFileWatcher();
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
      const fileArg = parts[1];

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
    if (!pi.setWidget) return;
    const extCount = Object.keys(doc?.extensions ?? {}).length;
    const skillCount = Object.keys(doc?.skills ?? {}).length;
    const total = config.peers.length;

    // Count WS-connected (real sync) and TCP-only reachable peers
    const wsOnline = config.peers.filter((p) => wsConnectedPeers.has(p.split(":")[0])).length;
    const tcpOnly = config.peers.filter((p) => {
      const h = p.split(":")[0];
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
          const host = p.split(":")[0];
          const mark = wsConnectedPeers.has(host) ? "🟢" : tcpReachablePeers.has(host) ? "🔵" : "🔴";
          return mark + " " + host;
        })
        .join(" ");
    }

    pi.setWidget("pi-sync", [
      `🔗 ${peerStatus}  │  📦 ${extCount}e ${skillCount}s`,
      ...(peerList ? [peerList] : []),
    ]);
  }

  // Update widget periodically + after probing
  setInterval(() => {
    if (handle) {
      handle.doc?.().then((doc?: PiConfigDocument) => updateStatusWidget(doc));
    } else {
      updateStatusWidget();
    }
  }, 5000);

  // ── Initialize repo in background ──────────────────────────────────

  try {
    await initRepo(pi);
  } catch (e: any) {
    console.error("[pi-sync] Failed to initialize sync repo:", e.message);
    // Commands still work — they'll report "not initialized"
    return;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    if (!handle) return;
    const doc = await handle.doc?.();
    if (!doc) return;

    handle.change?.((d: PiConfigDocument) => {
      importAllFiles(d);
    });

    // Start health probing
    startProbing();
  });

  pi.on("session_shutdown", async (event) => {
    stopProbing();
    if (handle) {
      const doc = await handle.doc?.();
      if (doc) {
        try {
          handle.change?.((d: PiConfigDocument) => {
            importAllFiles(d);
            d.lastSync[hostname] = Date.now();
          });
        } catch {}
      }
    }
    if (event.reason === "quit" || event.reason === "reload") {
      await shutdownRepo();
    }
  });

  // ── Start watcher after init ──────────────────────────────────────
  // initRepo has already completed at this point (awaited above), so
  // the repo and handle are ready.
  startFileWatcher();
}
