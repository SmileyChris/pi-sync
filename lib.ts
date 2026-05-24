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

export type Subdir = "settings" | "models" | "extensions" | "skills" | "prompts";

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  port: 3030,
  peers: [],
  syncSettings: true,
  syncExtensions: true,
  syncSkills: true,
  syncModels: true,
  syncPrompts: true,
};

// ── Path constants ───────────────────────────────────────────────────

const home = os.homedir();
export const PI_DIR = path.join(home, ".pi", "agent");
export const CONFIG_DIR = path.join(home, ".config", "pi-sync");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const DOC_URL_PATH = path.join(CONFIG_DIR, "doc-url");
export const AM_STORAGE = path.join(home, ".pi", "am-storage");
export const TRASH_DIR = path.join(PI_DIR, ".trash");

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
  return null;
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
};

export function shouldSync(fileKey: string, config: SyncConfig): boolean {
  if (isPiSyncExtensionKey(fileKey)) return false;
  const subdir = getSubdir(fileKey);
  if (!subdir) return false;
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

const EXTENSION_EXTS = [
  ".ts", ".js", ".css", ".json", ".wasm", ".html",
  ".svg", ".png", ".jpg", ".woff2", ".md",
] as const;

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
    { skipDirs: new Set(["node_modules"]), exts: [".md"], names: ["SKILL.md"] },
    readdirSync,
  );
}

export function collectPromptFiles(
  promptsDir: string,
  readdirSync: (dir: string) => fsDirEntry[],
): string[] {
  return walkCollect(
    promptsDir,
    { skipDirs: new Set(["node_modules"]), exts: [".md", ".txt"] },
    readdirSync,
  );
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
