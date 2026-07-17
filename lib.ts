/**
 * pi-sync shared library — pure functions and types.
 * Extracted from index.ts so core logic is unit-testable
 * without Automerge WASM, WebSocket, or the pi extension API.
 */

import * as path from "node:path";
import * as os from "node:os";

// ── Types ─────────────────────────────────────────────────────────────

export interface SyncedFile {
  // `string` at runtime is the common case, but Automerge proxies may
  // return an ImmutableString wrapper `{ val: string }`. Use unwrapContent.
  content: string | { val: string };
  installedAt: number;
  source?: string;
  /** Epoch ms when this file was soft-deleted; absence = live. */
  deletedAt?: number;
  /** Hostname that initiated the soft-delete (audit trail). */
  deletedBy?: string;
}

export interface KnownPeer {
  lastSeen: number;
  addedBy: string;
}

export interface PiConfigDocument {
  settings: Record<string, unknown>;
  models: Record<string, unknown>;
  extensions: Record<string, SyncedFile>;
  skills: Record<string, SyncedFile>;
  prompts: Record<string, SyncedFile>;
  sessions: Record<string, SyncedFile>;
  knownPeers: Record<string, KnownPeer>;
  localOnly: Record<string, string[]>;
  lastSync: Record<string, number>;
}

export interface SyncConfig {
  port: number;
  peers: string[];
  /** Maps real hostnames → config peer hostnames. Populated automatically
   *  when a peer-candidate event reveals the remote machine's actual
   *  hostname differs from the config peer alias (e.g. "chris-ms7b85" →
   *  "work"). Used to skip creating duplicate doc-known adapters. */
  peerAliases: Record<string, string>;
  syncSettings: boolean;
  syncExtensions: boolean;
  syncSkills: boolean;
  syncModels: boolean;
  syncPrompts: boolean;
  syncSessions: boolean;
}

export type Subdir = "settings" | "models" | "extensions" | "skills" | "prompts" | "sessions";

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  port: 3030,
  peers: [],
  peerAliases: {},
  syncSettings: true,
  syncExtensions: true,
  syncSkills: true,
  syncModels: true,
  syncPrompts: true,
  syncSessions: true,
};

// ── Path constants ───────────────────────────────────────────────────

const home = os.homedir();
export const PI_DIR = path.join(home, ".pi", "agent");
export const CONFIG_DIR = path.join(home, ".config", "pi-sync");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const DOC_URL_PATH = path.join(CONFIG_DIR, "doc-url");
export const AM_STORAGE = path.join(home, ".pi", "am-storage");
export const TRASH_DIR = path.join(PI_DIR, ".trash");
export const STATE_DIR = path.join(home, ".local", "state", "pi-sync");
export const DEBUG_LOG = path.join(STATE_DIR, "debug.log");
export const SESSIONS_DIR = path.join(PI_DIR, "sessions");

// ── Tombstone config ─────────────────────────────────────────────────

/** How long a tombstone lives before hard-purge (file + doc entry both gone). */
export const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Max disk-side deletions a single watcher flush may tombstone. Above
 *  this, the whole batch is aborted to protect against `rm -rf` / clean
 *  accidents propagating cluster-wide. */
export const MASS_DELETE_LIMIT = 5;

// ── Pure helpers ─────────────────────────────────────────────────────

export function normalizeFileKey(fileKey: string): string | null {
  if (!fileKey || fileKey.includes("\0")) return null;
  const unified = fileKey.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return null;
  const parts = unified.split("/");
  if (parts.some((part) => part === "..")) return null;
  const normalized = path.posix.normalize(unified);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

export function isPiSyncExtensionKey(fileKey: string): boolean {
  const key = normalizeFileKey(fileKey);
  return key === "extensions/pi-sync" || !!key?.startsWith("extensions/pi-sync/");
}

export function fileKey(filePath: string): string {
  return path.relative(PI_DIR, filePath);
}

export function getSubdir(fileKey: string): Subdir | null {
  const key = normalizeFileKey(fileKey);
  if (!key) return null;
  if (key === "settings.json") return "settings";
  if (key === "models.json") return "models";
  if (key.startsWith("extensions/"))
    return "extensions";
  if (key.startsWith("skills/"))
    return "skills";
  if (key.startsWith("prompts/"))
    return "prompts";
  if (key.startsWith("sessions/"))
    return "sessions";
  return null;
}

const EXTENSION_EXTS = [
  ".ts", ".js", ".css", ".json", ".wasm", ".html",
  ".svg", ".png", ".jpg", ".woff2", ".md",
] as const;

const SKILL_EXTS = [".md"] as const;
const PROMPT_EXTS = [".md", ".txt"] as const;

function hasAllowedSuffix(fileKey: string, exts: readonly string[]): boolean {
  return exts.some((ext) => fileKey.endsWith(ext));
}

function hasSkippedCollectionDir(fileKey: string): boolean {
  const parts = fileKey.split("/");
  return parts.slice(1, -1).some((part) => part === "node_modules" || part.startsWith("."));
}

export function isSupportedFileKey(fileKey: string): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return false;
  const subdir = getSubdir(key);
  if (subdir === "settings") return key === "settings.json";
  if (subdir === "models") return key === "models.json";
  if (!subdir) return false;
  if (hasSkippedCollectionDir(key)) return false;
  if (subdir === "extensions") return !isPiSyncExtensionKey(key) && hasAllowedSuffix(key, EXTENSION_EXTS);
  if (subdir === "skills") return hasAllowedSuffix(key, SKILL_EXTS);
  if (subdir === "prompts") return hasAllowedSuffix(key, PROMPT_EXTS);
  if (subdir === "sessions") return hasAllowedSuffix(key, SESSION_EXTS);
  return false;
}

/**
 * A file is local-only *for the active host* when the map lists one or
 * more hosts but does not include activeHost. Empty array = local-only
 * for everyone.
 */
export function isLocalOnlyByMap(
  localOnly: Record<string, string[]>,
  fileKey: string,
  activeHost: string,
): boolean {
  const key = normalizeFileKey(fileKey);
  if (!key) return true;
  let allowed: string[] | undefined;
  let matchedLength = -1;
  for (const [rawEntry, hosts] of Object.entries(localOnly)) {
    const entry = normalizeFileKey(rawEntry);
    if (!entry) continue;
    const matches = key === entry || key.startsWith(`${entry}/`);
    if (matches && entry.length > matchedLength) {
      allowed = hosts;
      matchedLength = entry.length;
    }
  }
  if (!allowed) return false;
  return !allowed.includes(activeHost);
}

export function isLocalOnly(
  doc: PiConfigDocument | undefined,
  fileKey: string,
  hostname: string,
): boolean {
  if (!doc) return false;
  return isLocalOnlyByMap(doc.localOnly, fileKey, hostname);
}

const SUBDIR_TO_TOGGLE: Record<Subdir, keyof SyncConfig> = {
  settings: "syncSettings",
  models: "syncModels",
  extensions: "syncExtensions",
  skills: "syncSkills",
  prompts: "syncPrompts",
  sessions: "syncSessions",
};

export function shouldSync(fileKey: string, config: SyncConfig): boolean {
  if (!isSupportedFileKey(fileKey)) return false;
  const subdir = getSubdir(fileKey);
  if (!subdir) return false;
  // Sessions are synced file-by-file over HTTP, not via Automerge CRDT
  if (subdir === "sessions") return false;
  return config[SUBDIR_TO_TOGGLE[subdir]] as boolean;
}

// ── Filesystem walker ────────────────────────────────────────────────

export interface fsDirEntry {
  name: string;
  isDirectory(): boolean;
}

export interface MinimalFS {
  existsSync(p: string): boolean;
  readdirSync(p: string): fsDirEntry[];
}

interface WalkRules {
  /** Directory names to skip (matched verbatim against entry.name). */
  skipDirs?: Set<string>;
  /** Accept a file if it matches any of these suffixes. */
  exts?: readonly string[];
  /** Accept a file if its name matches one of these exact names. */
  names?: readonly string[];
}

function walkCollect(
  root: string,
  rules: WalkRules,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  const out: string[] = [];
  const skip = rules.skipDirs ?? new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith(".")) walk(full);
        continue;
      }
      const nameMatch = rules.names?.includes(entry.name) ?? false;
      const extMatch = rules.exts?.some((e) => entry.name.endsWith(e)) ?? false;
      if (nameMatch || extMatch) out.push(fileKey(full));
    }
  };
  walk(root);
  return out;
}

export function collectExtensionFiles(
  extDir: string,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  return walkCollect(
    extDir,
    { skipDirs: new Set(["pi-sync", "node_modules"]), exts: EXTENSION_EXTS },
    readdirSync,
  );
}

export function collectSkillFiles(
  skillsDir: string,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  return walkCollect(
    skillsDir,
    { skipDirs: new Set(["node_modules"]), exts: SKILL_EXTS, names: ["SKILL.md"] },
    readdirSync,
  );
}

export function collectPromptFiles(
  promptsDir: string,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  return walkCollect(
    promptsDir,
    { skipDirs: new Set(["node_modules"]), exts: PROMPT_EXTS },
    readdirSync,
  );
}

const SESSION_EXTS = [".jsonl"] as const;

export function collectSessionFiles(
  sessionsDir: string,
  hostname: string,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  // Walk sessions/ but only collect files under --...-- dirs (pi's
  // CWD-derived session directories). Skip loose hostname directories
  // that contain synced sessions to avoid re-syncing.
  // Keys are sessions/{hostname}/{rel} so remote sessions land in
  // their own hostname directory on every peer.
  const results: string[] = [];
  let entries: fsDirEntry[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return results;
  }
  const prefix = `sessions/${hostname}/`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("--")) continue;
    walkSessionDir(path.join(sessionsDir, entry.name), entry.name, readdirSync, results, prefix);
  }
  return results;
}

/** Convert a native pi session path (relative to sessions/) into the
 * hostname-namespaced key used by the HTTP session transport. Only pi's
 * native `--cwd--/...jsonl` tree is eligible; already-synced hostname
 * directories are deliberately rejected to prevent echo loops. */
export function sessionKeyForLocalRelative(
  relativePath: string,
  sourceHostname: string,
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sourceHostname)) return null;
  const relative = normalizeFileKey(relativePath);
  if (!relative || !relative.endsWith(".jsonl")) return null;
  const parts = relative.split("/");
  if (parts.length < 2 || !parts[0].startsWith("--")) return null;
  return normalizeFileKey(`sessions/${sourceHostname}/${relative}`);
}

/** Validate an incoming namespaced session key. Returns the normalized key
 * that may be written below PI_DIR, or null when the key is malformed, points
 * at our own hostname, or does not target a native pi session subtree. */
export function validateIncomingSessionKey(
  rawKey: string,
  localHostname: string,
): string | null {
  const key = normalizeFileKey(rawKey);
  if (!key || !key.endsWith(".jsonl")) return null;
  const parts = key.split("/");
  if (parts.length < 4 || parts[0] !== "sessions") return null;
  const sourceHostname = parts[1];
  if (
    !/^[A-Za-z0-9._-]+$/.test(sourceHostname) ||
    sourceHostname === localHostname ||
    !parts[2].startsWith("--")
  ) return null;
  return key;
}

function walkSessionDir(
  dir: string,
  relPrefix: string,
  readdirSync: (dir: string) => fsDirEntry[],
  out: string[],
  keyPrefix: string,
) {
  let entries: fsDirEntry[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkSessionDir(full, rel, readdirSync, out, keyPrefix);
    } else if (entry.name.endsWith(".jsonl") && entry.name !== "pins.json" && entry.name !== "active-sessions.json") {
      out.push(keyPrefix + rel);
    }
  }
}

// ── Import helpers ───────────────────────────────────────────────────

/**
 * Returns merged object when file has changes vs existingDoc, null
 * otherwise. Pure: does not mutate inputs.
 */
export function mergeSettingsIntoDoc(
  existingDoc: Record<string, unknown>,
  fileContent: string,
): Record<string, unknown> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    return null;
  }

  const merged = { ...existingDoc };
  let hasDiff = false;

  for (const [k, v] of Object.entries(parsed)) {
    if (JSON.stringify(merged[k]) !== JSON.stringify(v)) {
      hasDiff = true;
      merged[k] = v;
    }
  }
  for (const k of Object.keys(merged)) {
    if (!(k in parsed)) {
      hasDiff = true;
      delete merged[k];
    }
  }

  return hasDiff ? merged : null;
}

/**
 * Apply a JSON file's contents to a settings/models subtree in place.
 * `target` is an Automerge proxy; writes only plain parsed values, never
 * re-assigns nested proxies (which would throw "Cannot create a reference
 * to an existing document object"). Returns true if anything changed.
 */
export function applyJsonMergeInPlace(
  target: Record<string, unknown>,
  fileContent: string,
): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    return false;
  }
  let changed = false;
  for (const k of Object.keys(target)) {
    if (!(k in parsed)) {
      delete target[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (JSON.stringify(target[k]) !== JSON.stringify(v)) {
      target[k] = v;
      changed = true;
    }
  }
  return changed;
}

/** True iff the file entry has a soft-delete marker. */
export function isTombstone(file: SyncedFile | undefined): boolean {
  return !!file && typeof file.deletedAt === "number";
}

/** True iff the tombstone is older than the TTL and can be hard-purged. */
export function isPastTTL(
  file: SyncedFile | undefined,
  now: number,
  ttlMs: number = TOMBSTONE_TTL_MS,
): boolean {
  if (!isTombstone(file)) return false;
  return now - (file!.deletedAt as number) > ttlMs;
}

/** Unwrap a SyncedFile content (handles ImmutableString { val } proxy). */
export function unwrapContent(file: SyncedFile | undefined): string | null {
  if (!file) return null;
  const c = file.content;
  return typeof c === "string" ? c : (c?.val ?? null);
}

export function syncedFileContentMatches(
  existing: SyncedFile | undefined,
  content: string,
): boolean {
  return unwrapContent(existing) === content;
}

// ── Config I/O ───────────────────────────────────────────────────────

export function loadConfig(
  configPath: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string, encoding: string) => string,
): SyncConfig {
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return { ...DEFAULT_SYNC_CONFIG, ...raw };
    }
  } catch {
    /* corrupt config → fall through to defaults */
  }
  return { ...DEFAULT_SYNC_CONFIG };
}

// ── Patch helpers ────────────────────────────────────────────────────

/** Minimal Patch shape — matches A.Patch's path field. */
export interface PatchLike {
  path: ReadonlyArray<string | number>;
}

/** Extract the set of fileKeys whose on-disk content might need re-export
 *  given a list of patches. Settings/models map to their fixed filenames;
 *  collection sections (extensions/skills/prompts) and localOnly map to
 *  the second path segment (which IS the fileKey). lastSync is ignored. */
export function dirtyKeysFromPatches(patches: ReadonlyArray<PatchLike>): Set<string> {
  const dirty = new Set<string>();
  for (const p of patches) {
    const section = p.path[0];
    if (typeof section !== "string") continue;
    if (section === "settings") {
      dirty.add("settings.json");
    } else if (section === "models") {
      dirty.add("models.json");
    } else if (
      section === "extensions" ||
      section === "skills" ||
      section === "prompts" ||
      section === "sessions" ||
      section === "localOnly"
    ) {
      const key = p.path[1];
      if (typeof key === "string") {
        const normalized = normalizeFileKey(key);
        if (normalized) dirty.add(normalized);
      }
    }
    // lastSync intentionally ignored — pure metadata
  }
  return dirty;
}

export type PartitionedChanges = {
  /** Keys that exist on disk → import/update in the doc. */
  present: string[];
  /** Keys that vanished from disk but still have a live (non-tombstoned)
   *  entry in the doc → candidates to tombstone. */
  deletions: string[];
  /** True if the candidate-delete count exceeds MASS_DELETE_LIMIT; the
   *  caller should refuse to write the tombstones. */
  blockedDeletions: boolean;
};

/** Partition a batch of pending file-watcher events into present/delete
 *  buckets plus a mass-delete brake. Pure: the caller supplies an
 *  existence probe so this is testable without touching fs. */
export function partitionPendingChanges(
  rawKeys: Iterable<string>,
  config: SyncConfig,
  doc: PiConfigDocument,
  exists: (key: string) => boolean,
): PartitionedChanges {
  const present: string[] = [];
  const deletions: string[] = [];
  for (const rawKey of rawKeys) {
    const key = normalizeFileKey(rawKey);
    if (!key || !shouldSync(key, config)) continue;
    if (exists(key)) {
      present.push(key);
      continue;
    }
    const subdir = getSubdir(key);
    // Settings/models are whole-file JSON; their absence on disk is not a
    // delete signal (avoids propagating transient removals).
    if (subdir !== "extensions" && subdir !== "skills" && subdir !== "prompts") continue;
    const collection = doc[subdir] as Record<string, SyncedFile>;
    const entry = collection?.[key];
    if (entry && !isTombstone(entry)) deletions.push(key);
  }
  return {
    present,
    deletions,
    blockedDeletions: deletions.length > MASS_DELETE_LIMIT,
  };
}

/** True iff the doc has no synced content in any collection. Writing the
 *  empty shape to disk on first run would wipe local files, so callers
 *  short-circuit exports when this is true. */
export function isDocEmpty(doc: PiConfigDocument): boolean {
  return (
    Object.keys(doc.extensions).length === 0 &&
    Object.keys(doc.skills).length === 0 &&
    Object.keys(doc.prompts).length === 0 &&
    Object.keys(doc.settings).length === 0 &&
    Object.keys(doc.models).length === 0
  );
}

/**
 * Compute the effective set of peer hostnames by unioning config seeds
 * and doc's knownPeers roster (excluding self). Returns unique hostnames.
 */
/** Compute and return the set of mesh peer hostnames from config seeds
 *  and doc knownPeers (excluding self). Pure — takes inputs, returns set.
 *  peerAliases maps real hostnames → config peer hostnames, so a doc-known
 *  host that is an alias of a config peer is excluded (no duplicate). */
export function computeMeshPeerHosts(
  configPeers: string[],
  docKnownPeers: Record<string, KnownPeer> | undefined,
  hostname: string,
  peerAliases?: Record<string, string>,
): Set<string> {
  const hosts = new Set<string>();
  const configHosts = new Set<string>();
  for (const p of configPeers) {
    const h = peerHost(p);
    if (h !== hostname) {
      hosts.add(h);
      configHosts.add(h);
    }
  }
  if (docKnownPeers) {
    for (const h of Object.keys(docKnownPeers)) {
      if (h === hostname) continue;
      // If this host is an alias for a config host, skip — already covered
      if (peerAliases?.[h] && configHosts.has(peerAliases[h])) continue;
      hosts.add(h);
    }
  }
  return hosts;
}

export function effectivePeers(
  configPeers: string[],
  docKnownPeers: Record<string, KnownPeer> | undefined,
  hostname: string,
  peerAliases?: Record<string, string>,
): string[] {
  const hosts = new Set<string>();
  const configHosts = new Set<string>();
  for (const p of configPeers) {
    const h = peerHost(p);
    if (h !== hostname) {
      hosts.add(h);
      configHosts.add(h);
    }
  }
  if (docKnownPeers) {
    for (const h of Object.keys(docKnownPeers)) {
      if (h === hostname) continue;
      if (peerAliases?.[h] && configHosts.has(peerAliases[h])) continue;
      hosts.add(h);
    }
  }
  return [...hosts];
}

// ── Peer helpers ─────────────────────────────────────────────────────

export function parsePeer(peer: string): { host: string; port: number } | null {
  const idx = peer.lastIndexOf(":");
  if (idx === -1) return null;
  const host = peer.slice(0, idx);
  const port = parseInt(peer.slice(idx + 1), 10);
  if (!host || isNaN(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Extract host portion of a "host:port" peer string. */
export function peerHost(peer: string): string {
  const idx = peer.lastIndexOf(":");
  return idx === -1 ? peer : peer.slice(0, idx);
}
