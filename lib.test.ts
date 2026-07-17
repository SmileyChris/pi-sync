/**
 * Tests for pi-sync lib.ts — pure functions and core logic.
 *
 * Run:  npx vitest run
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as Automerge from "@automerge/automerge";
import {
  type SyncConfig,
  type PiConfigDocument,
  DEFAULT_SYNC_CONFIG,
  normalizeFileKey,
  isPiSyncExtensionKey,
  fileKey,
  getSubdir,
  isSupportedFileKey,
  isLocalOnlyByMap,
  isLocalOnly,
  shouldSync,
  mergeSettingsIntoDoc,
  applyJsonMergeInPlace,
  unwrapContent,
  syncedFileContentMatches,
  loadConfig,
  parsePeer,
  peerHost,
  collectExtensionFiles,
  collectSkillFiles,
  collectPromptFiles,
  collectSessionFiles,
  sessionKeyForLocalRelative,
  validateIncomingSessionKey,
  dirtyKeysFromPatches,
  isDocEmpty,
  isTombstone,
  isPastTTL,
  partitionPendingChanges,
  MASS_DELETE_LIMIT,
  TOMBSTONE_TTL_MS,
  PI_DIR,
  type fsDirEntry,
} from "./lib";

// ── Test helpers ─────────────────────────────────────────────────────

/**
 * Build a synthetic readdirSync from a nested object describing the tree.
 * Keys are entry names; `null` value = file, nested object = directory.
 *
 *   makeFS("/root", { "my-ext": { "index.ts": null } })
 *     → readdirSync("/root") returns [{name:"my-ext", isDirectory:()=>true}]
 *     → readdirSync("/root/my-ext") returns [{name:"index.ts", isDirectory:()=>false}]
 */
type Tree = { [name: string]: Tree | null };

function makeFS(root: string, tree: Tree) {
  const dirs: Record<string, fsDirEntry[]> = {};
  const walk = (curr: string, node: Tree) => {
    const entries: fsDirEntry[] = [];
    for (const [name, child] of Object.entries(node)) {
      const isDir = child !== null;
      entries.push({ name, isDirectory: () => isDir });
      if (isDir) walk(path.join(curr, name), child as Tree);
    }
    dirs[curr] = entries;
  };
  walk(root, tree);
  return (dir: string) => dirs[dir] ?? [];
}

const hostA = "hostA";
const hostB = "hostB";

// ══════════════════════════════════════════════════════════════════════
//  normalizeFileKey / isPiSyncExtensionKey
// ══════════════════════════════════════════════════════════════════════

describe("normalizeFileKey", () => {
  it("normalizes windows separators", () => {
    expect(normalizeFileKey("extensions\\foo\\index.ts")).toBe("extensions/foo/index.ts");
  });

  it.each([
    [""],
    ["/absolute/path"],
    ["C:\\absolute\\path"],
    ["extensions/../settings.json"],
    ["extensions/foo/../../settings.json"],
    ["extensions/\0bad"],
  ])("rejects unsafe key %s", (key) => {
    expect(normalizeFileKey(key)).toBeNull();
  });
});

describe("isPiSyncExtensionKey", () => {
  it("matches pi-sync and its descendants", () => {
    expect(isPiSyncExtensionKey("extensions/pi-sync")).toBe(true);
    expect(isPiSyncExtensionKey("extensions/pi-sync/index.ts")).toBe(true);
  });

  it("does not match similarly named extensions", () => {
    expect(isPiSyncExtensionKey("extensions/pi-sync-extra/index.ts")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  fileKey
// ══════════════════════════════════════════════════════════════════════

describe("fileKey", () => {
  it("returns relative path from PI_DIR", () => {
    expect(fileKey(path.join(PI_DIR, "settings.json"))).toBe("settings.json");
  });

  it("returns nested extension path", () => {
    const p = path.join(PI_DIR, "extensions", "my-ext", "index.ts");
    expect(fileKey(p)).toBe(
      path.sep === "/" ? "extensions/my-ext/index.ts" : path.normalize("extensions/my-ext/index.ts"),
    );
  });

  it("handles skills directory", () => {
    const p = path.join(PI_DIR, "skills", "my-skill", "SKILL.md");
    expect(fileKey(p)).toBe(
      path.sep === "/" ? "skills/my-skill/SKILL.md" : path.normalize("skills/my-skill/SKILL.md"),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
//  getSubdir
// ══════════════════════════════════════════════════════════════════════

describe("getSubdir", () => {
  it.each([
    ["settings.json", "settings"],
    ["models.json", "models"],
    ["extensions/foo/index.ts", "extensions"],
    ["extensions\\foo\\index.ts", "extensions"], // windows
    ["skills/my-skill/SKILL.md", "skills"],
    ["prompts/custom.md", "prompts"],
    ["sessions/foo.jsonl", "sessions"],
  ])("maps %s → %s", (key, expected) => {
    expect(getSubdir(key)).toBe(expected);
  });

  it.each([
    ["unknown/file.txt"],
    [""],
    ["auth.json"],
    ["extensions-foo.md"], // name-similar to a subdir but not under it
    ["extensions/../settings.json"],
    ["/extensions/foo/index.ts"],
  ])("returns null for %s", (key) => {
    expect(getSubdir(key)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  isLocalOnlyByMap / isLocalOnly
// ══════════════════════════════════════════════════════════════════════

describe("isLocalOnlyByMap", () => {
  const localOnly: Record<string, string[]> = {
    "extensions/pi-sync": [hostA],
    "skills/secret": [hostA, hostB],
  };

  it("returns true when host NOT in allowlist", () => {
    expect(isLocalOnlyByMap(localOnly, "extensions/pi-sync", hostB)).toBe(true);
  });

  it("returns false when host IS in allowlist", () => {
    expect(isLocalOnlyByMap(localOnly, "extensions/pi-sync", hostA)).toBe(false);
  });

  it("returns false for files not in map", () => {
    expect(isLocalOnlyByMap(localOnly, "skills/public", hostA)).toBe(false);
  });

  it("returns false for empty map", () => {
    expect(isLocalOnlyByMap({}, "anything", hostA)).toBe(false);
  });

  it("treats empty allowlist as local-only for everyone", () => {
    expect(isLocalOnlyByMap({ x: [] }, "x", hostA)).toBe(true);
  });

  it("matches directory-style local-only entries by path segment", () => {
    expect(isLocalOnlyByMap(localOnly, "extensions/pi-sync/index.ts", hostB)).toBe(true);
    expect(isLocalOnlyByMap(localOnly, "extensions/pi-sync-extra/index.ts", hostB)).toBe(false);
  });

  it("uses the most specific matching local-only entry", () => {
    const map = {
      "extensions/foo": [hostA],
      "extensions/foo/public": [hostB],
    };
    expect(isLocalOnlyByMap(map, "extensions/foo/private/index.ts", hostB)).toBe(true);
    expect(isLocalOnlyByMap(map, "extensions/foo/public/index.ts", hostB)).toBe(false);
  });

  it("treats unsafe keys as local-only", () => {
    expect(isLocalOnlyByMap(localOnly, "extensions/../../secret", hostA)).toBe(true);
  });
});

describe("isLocalOnly", () => {
  it("returns false for undefined doc", () => {
    expect(isLocalOnly(undefined, "anything", hostA)).toBe(false);
  });

  it("consults doc.localOnly when doc is present", () => {
    const doc: PiConfigDocument = {
      settings: {},
      models: {},
      extensions: {},
      skills: {},
      prompts: {},
      localOnly: { "extensions/foo": [hostB] },
      lastSync: {},
    };
    expect(isLocalOnly(doc, "extensions/foo", hostA)).toBe(true);
    expect(isLocalOnly(doc, "extensions/foo", hostB)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  shouldSync
// ══════════════════════════════════════════════════════════════════════

describe("shouldSync", () => {
  const allOff: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    syncSettings: false,
    syncModels: false,
    syncExtensions: false,
    syncSkills: false,
    syncPrompts: false,
    syncSessions: false,
  };

  it.each([
    ["settings.json", "syncSettings"],
    ["models.json", "syncModels"],
    ["extensions/foo/index.ts", "syncExtensions"],
    ["skills/foo/SKILL.md", "syncSkills"],
    ["prompts/foo.md", "syncPrompts"],
  ] as const)("respects %s toggle via %s", (key, toggle) => {
    expect(shouldSync(key, DEFAULT_SYNC_CONFIG)).toBe(true);
    expect(shouldSync(key, allOff)).toBe(false);
    expect(shouldSync(key, { ...allOff, [toggle]: true })).toBe(true);
  });

  it("excludes sessions from CRDT sync", () => {
    expect(shouldSync("sessions/foo.jsonl", DEFAULT_SYNC_CONFIG)).toBe(false);
  });

  it("returns false for unknown subdir", () => {
    expect(shouldSync("unknown/file.txt", DEFAULT_SYNC_CONFIG)).toBe(false);
  });

  it("never syncs pi-sync itself", () => {
    expect(shouldSync("extensions/pi-sync/index.ts", DEFAULT_SYNC_CONFIG)).toBe(false);
  });

  it.each([
    "extensions/foo/runtime.db",
    "extensions/foo/notes.txt",
    "extensions/foo/node_modules/dep/index.ts",
    "extensions/foo/.cache/index.ts",
    "skills/foo/script.ts",
    "skills/foo/.cache/notes.md",
    "prompts/foo/data.json",
    "prompts/foo/.cache/system.md",
  ])("rejects unsupported or skipped file key %s", (key) => {
    expect(isSupportedFileKey(key)).toBe(false);
    expect(shouldSync(key, DEFAULT_SYNC_CONFIG)).toBe(false);
  });

  it.each([
    "extensions/foo/index.ts",
    "extensions/foo/assets/icon.svg",
    "skills/foo/SKILL.md",
    "prompts/foo/system.md",
    "prompts/foo/plain.txt",
  ])("accepts supported file key %s", (key) => {
    expect(isSupportedFileKey(key)).toBe(true);
    expect(shouldSync(key, DEFAULT_SYNC_CONFIG)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  mergeSettingsIntoDoc
// ══════════════════════════════════════════════════════════════════════

describe("mergeSettingsIntoDoc", () => {
  it("returns null when JSON is invalid", () => {
    expect(mergeSettingsIntoDoc({}, "not json")).toBeNull();
  });

  it("returns null when file matches existing doc", () => {
    const doc = { a: 1, b: "hello" };
    expect(mergeSettingsIntoDoc(doc, JSON.stringify(doc))).toBeNull();
  });

  it("returns null when only whitespace differs", () => {
    expect(mergeSettingsIntoDoc({ a: 1 }, '{\n  "a": 1\n}')).toBeNull();
  });

  it("returns null when both empty", () => {
    expect(mergeSettingsIntoDoc({}, "{}")).toBeNull();
  });

  it("returns merged object when file has new keys", () => {
    expect(mergeSettingsIntoDoc({ a: 1 }, JSON.stringify({ a: 1, b: 2 }))).toEqual({ a: 1, b: 2 });
  });

  it("removes keys present in doc but not in file", () => {
    expect(mergeSettingsIntoDoc({ a: 1, b: 2 }, JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  });

  it("detects changed values", () => {
    expect(mergeSettingsIntoDoc({ a: 1 }, JSON.stringify({ a: 2 }))).toEqual({ a: 2 });
  });

  it("removes all keys when file is empty object", () => {
    expect(mergeSettingsIntoDoc({ a: 1, b: 2 }, "{}")).toEqual({});
  });

  it("does not mutate the input doc", () => {
    const doc = { a: 1, b: 2 };
    mergeSettingsIntoDoc(doc, JSON.stringify({ a: 1 }));
    expect(doc).toEqual({ a: 1, b: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════
//  applyJsonMergeInPlace — must work on real Automerge proxies
// ══════════════════════════════════════════════════════════════════════

describe("applyJsonMergeInPlace", () => {
  it("returns false on invalid JSON", () => {
    expect(applyJsonMergeInPlace({}, "not json")).toBe(false);
  });

  it("returns false when content matches", () => {
    expect(applyJsonMergeInPlace({ a: 1 }, '{"a":1}')).toBe(false);
  });

  it("writes added/changed keys and deletes missing keys on plain objects", () => {
    const target: Record<string, unknown> = { a: 1, b: 2 };
    const changed = applyJsonMergeInPlace(target, JSON.stringify({ a: 1, c: 3 }));
    expect(changed).toBe(true);
    expect(target).toEqual({ a: 1, c: 3 });
  });

  // Regression: previously, spread of an Automerge proxy captured nested
  // proxies; reassigning them threw "Cannot create a reference to an
  // existing document object" inside Automerge.change.
  it("does not throw when applied to an Automerge proxy with nested objects", () => {
    let doc = Automerge.from({
      models: {
        opus: { id: "claude-opus", display: "Opus" },
        sonnet: { id: "claude-sonnet", display: "Sonnet" },
      },
    } as Record<string, unknown>);

    const newContent = JSON.stringify({
      opus: { id: "claude-opus", display: "Opus 4.7" },
      sonnet: { id: "claude-sonnet", display: "Sonnet" },
    });

    expect(() => {
      doc = Automerge.change(doc, (d: any) => {
        applyJsonMergeInPlace(d.models, newContent);
      });
    }).not.toThrow();

    expect((doc as any).models.opus.display).toBe("Opus 4.7");
    expect((doc as any).models.sonnet.id).toBe("claude-sonnet");
  });

  it("deletes nested keys removed from JSON on an Automerge proxy", () => {
    let doc = Automerge.from({
      models: {
        opus: { id: "claude-opus" },
        sonnet: { id: "claude-sonnet" },
      },
    } as Record<string, unknown>);

    const newContent = JSON.stringify({ opus: { id: "claude-opus" } });

    doc = Automerge.change(doc, (d: any) => {
      applyJsonMergeInPlace(d.models, newContent);
    });

    expect((doc as any).models.sonnet).toBeUndefined();
    expect((doc as any).models.opus.id).toBe("claude-opus");
  });
});

// ══════════════════════════════════════════════════════════════════════
//  unwrapContent
// ══════════════════════════════════════════════════════════════════════

describe("unwrapContent", () => {
  it("returns null for undefined", () => {
    expect(unwrapContent(undefined)).toBeNull();
  });

  it("returns plain string content", () => {
    expect(unwrapContent({ content: "hi", installedAt: 0 })).toBe("hi");
  });

  it("unwraps ImmutableString { val }", () => {
    expect(unwrapContent({ content: { val: "hi" }, installedAt: 0 })).toBe("hi");
  });
});

// ══════════════════════════════════════════════════════════════════════
//  syncedFileContentMatches
// ══════════════════════════════════════════════════════════════════════

describe("syncedFileContentMatches", () => {
  const content = "console.log('hi');";

  it("returns false when existing is undefined", () => {
    expect(syncedFileContentMatches(undefined, content)).toBe(false);
  });

  it("returns true when plain string matches", () => {
    expect(syncedFileContentMatches({ content, installedAt: 0 }, content)).toBe(true);
  });

  it("returns false when plain string differs", () => {
    expect(syncedFileContentMatches({ content: "other", installedAt: 0 }, content)).toBe(false);
  });

  it("handles ImmutableString wrapper (match)", () => {
    expect(syncedFileContentMatches({ content: { val: content }, installedAt: 0 }, content)).toBe(true);
  });

  it("handles ImmutableString wrapper (mismatch)", () => {
    expect(syncedFileContentMatches({ content: { val: "different" }, installedAt: 0 }, "expected")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  loadConfig
// ══════════════════════════════════════════════════════════════════════

describe("loadConfig", () => {
  it("returns defaults when file doesn't exist", () => {
    expect(loadConfig("/nope", () => false, () => "")).toEqual(DEFAULT_SYNC_CONFIG);
  });

  it("merges partial config with defaults", () => {
    const cfg = loadConfig(
      "/fake",
      () => true,
      () => JSON.stringify({ port: 4040, peers: ["a:3030"] }),
    );
    expect(cfg.port).toBe(4040);
    expect(cfg.peers).toEqual(["a:3030"]);
    expect(cfg.syncSettings).toBe(true);
    expect(cfg.syncExtensions).toBe(true);
  });

  it("returns defaults on corrupt JSON", () => {
    const cfg = loadConfig("/fake", () => true, () => "{not valid json");
    expect(cfg).toEqual(DEFAULT_SYNC_CONFIG);
  });

  it("overrides all toggles", () => {
    const cfg = loadConfig(
      "/fake",
      () => true,
      () => JSON.stringify({
        syncSettings: false,
        syncModels: false,
        syncExtensions: false,
        syncSkills: false,
        syncPrompts: false,
      }),
    );
    expect(cfg.syncSettings).toBe(false);
    expect(cfg.syncModels).toBe(false);
    expect(cfg.syncExtensions).toBe(false);
    expect(cfg.syncSkills).toBe(false);
    expect(cfg.syncPrompts).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  parsePeer
// ══════════════════════════════════════════════════════════════════════

describe("parsePeer", () => {
  it("parses hostname:port", () => {
    expect(parsePeer("laptop.tailnet.ts.net:3030")).toEqual({
      host: "laptop.tailnet.ts.net",
      port: 3030,
    });
  });

  it("parses IPv4:port", () => {
    expect(parsePeer("192.168.1.5:4040")).toEqual({ host: "192.168.1.5", port: 4040 });
  });

  it("returns null when input has no colon", () => {
    expect(parsePeer("justahostname")).toBeNull();
  });

  it.each(["host:abc", "host:0", "host:99999"])("rejects invalid port %s", (s) => {
    expect(parsePeer(s)).toBeNull();
  });

  it("rejects empty host", () => {
    expect(parsePeer(":3030")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parsePeer("")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  peerHost
// ══════════════════════════════════════════════════════════════════════

describe("peerHost", () => {
  it("extracts host from host:port", () => {
    expect(peerHost("laptop.ts.net:3030")).toBe("laptop.ts.net");
  });

  it("returns the input unchanged when no colon", () => {
    expect(peerHost("justahostname")).toBe("justahostname");
  });

  it("splits on the last colon (port side wins)", () => {
    expect(peerHost("weird:host:3030")).toBe("weird:host");
  });
});

// ══════════════════════════════════════════════════════════════════════
//  isTombstone / isPastTTL
// ══════════════════════════════════════════════════════════════════════

describe("isTombstone", () => {
  it("returns false for undefined", () => {
    expect(isTombstone(undefined)).toBe(false);
  });

  it("returns false for live entries", () => {
    expect(isTombstone({ content: "x", installedAt: 0 })).toBe(false);
  });

  it("returns true when deletedAt is set", () => {
    expect(isTombstone({ content: "x", installedAt: 0, deletedAt: 123 })).toBe(true);
  });

  it("returns false when deletedAt is non-numeric", () => {
    expect(isTombstone({ content: "x", installedAt: 0, deletedAt: undefined })).toBe(false);
  });
});

describe("isPastTTL", () => {
  const now = 10_000_000_000;
  const ttl = 1000;

  it("returns false for non-tombstoned entries", () => {
    expect(isPastTTL({ content: "x", installedAt: 0 }, now, ttl)).toBe(false);
  });

  it("returns true when (now - deletedAt) > ttl", () => {
    expect(isPastTTL({ content: "x", installedAt: 0, deletedAt: now - ttl - 1 }, now, ttl)).toBe(true);
  });

  it("returns false at exactly ttl boundary", () => {
    expect(isPastTTL({ content: "x", installedAt: 0, deletedAt: now - ttl }, now, ttl)).toBe(false);
  });

  it("returns false when fresh tombstone", () => {
    expect(isPastTTL({ content: "x", installedAt: 0, deletedAt: now - 1 }, now, ttl)).toBe(false);
  });

  it("uses default TOMBSTONE_TTL_MS when ttl arg omitted", () => {
    const fresh = { content: "x", installedAt: 0, deletedAt: now - 1 };
    const stale = { content: "x", installedAt: 0, deletedAt: now - TOMBSTONE_TTL_MS - 1 };
    expect(isPastTTL(fresh, now)).toBe(false);
    expect(isPastTTL(stale, now)).toBe(true);
  });
});

describe("tombstone constants", () => {
  it("TOMBSTONE_TTL_MS is 14 days", () => {
    expect(TOMBSTONE_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("MASS_DELETE_LIMIT is positive", () => {
    expect(MASS_DELETE_LIMIT).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  dirtyKeysFromPatches
// ══════════════════════════════════════════════════════════════════════

describe("dirtyKeysFromPatches", () => {
  it("returns empty set for empty patches", () => {
    expect(dirtyKeysFromPatches([])).toEqual(new Set());
  });

  it("maps settings section to settings.json", () => {
    expect(dirtyKeysFromPatches([{ path: ["settings", "theme"] }])).toEqual(
      new Set(["settings.json"]),
    );
  });

  it("maps models section to models.json", () => {
    expect(dirtyKeysFromPatches([{ path: ["models", "claude-opus"] }])).toEqual(
      new Set(["models.json"]),
    );
  });

  it("extracts fileKey from extensions/skills/prompts patches", () => {
    const patches = [
      { path: ["extensions", "extensions/foo/index.ts", "content"] },
      { path: ["skills", "skills/bar/SKILL.md"] },
      { path: ["prompts", "prompts/x.md", "content", 5] },
    ];
    expect(dirtyKeysFromPatches(patches)).toEqual(
      new Set([
        "extensions/foo/index.ts",
        "skills/bar/SKILL.md",
        "prompts/x.md",
      ]),
    );
  });

  it("treats localOnly changes as dirtying the referenced fileKey", () => {
    expect(
      dirtyKeysFromPatches([{ path: ["localOnly", "extensions/private"] }]),
    ).toEqual(new Set(["extensions/private"]));
  });

  it("ignores lastSync patches", () => {
    expect(dirtyKeysFromPatches([{ path: ["lastSync", "hostA"] }])).toEqual(
      new Set(),
    );
  });

  it("ignores patches whose section is not a string", () => {
    expect(dirtyKeysFromPatches([{ path: [0, "x"] }])).toEqual(new Set());
  });

  it("deduplicates multiple patches targeting the same file", () => {
    const fileKey = "extensions/foo/index.ts";
    expect(
      dirtyKeysFromPatches([
        { path: ["extensions", fileKey, "content"] },
        { path: ["extensions", fileKey, "installedAt"] },
        { path: ["extensions", fileKey] },
      ]),
    ).toEqual(new Set([fileKey]));
  });

  it("drops unsafe collection keys", () => {
    expect(
      dirtyKeysFromPatches([{ path: ["extensions", "extensions/../../../.ssh/authorized_keys"] }]),
    ).toEqual(new Set());
  });

  it("merges patches across many sections", () => {
    const patches = [
      { path: ["settings", "a"] },
      { path: ["models", "b"] },
      { path: ["extensions", "extensions/e/x.ts"] },
      { path: ["lastSync", "host"] },
    ];
    expect(dirtyKeysFromPatches(patches)).toEqual(
      new Set(["settings.json", "models.json", "extensions/e/x.ts"]),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Collection helpers
// ══════════════════════════════════════════════════════════════════════

describe("collectExtensionFiles", () => {
  const root = "/extensions";

  it("collects supported file types", () => {
    const fs = makeFS(root, {
      "my-ext": {
        "index.ts": null,
        "lib.js": null,
        "style.css": null,
        "data.json": null,
        "module.wasm": null,
        "page.html": null,
        "icon.svg": null,
        "logo.png": null,
        "photo.jpg": null,
        "font.woff2": null,
        "README.md": null,
      },
    });
    expect(collectExtensionFiles(root, fs).length).toBe(11);
  });

  it("skips unsupported file types", () => {
    const fs = makeFS(root, {
      "my-ext": { "notes.txt": null, "script.py": null },
    });
    expect(collectExtensionFiles(root, fs)).toEqual([]);
  });

  it("skips pi-sync, node_modules, and dot-directories", () => {
    const fs = makeFS(root, {
      "my-ext": { "index.ts": null },
      "pi-sync": { "index.ts": null },
      "node_modules": { "dep": { "x.ts": null } },
      ".git": { "config": null },
    });
    expect(collectExtensionFiles(root, fs).length).toBe(1);
  });

  it("recurses into nested directories", () => {
    const fs = makeFS(root, {
      "my-ext": { "src": { "deep": { "index.ts": null } } },
    });
    expect(collectExtensionFiles(root, fs).length).toBe(1);
  });
});

describe("collectSkillFiles", () => {
  const root = "/skills";

  it("collects .md files including SKILL.md", () => {
    const fs = makeFS(root, {
      "my-skill": { "SKILL.md": null, "helper.md": null },
    });
    expect(collectSkillFiles(root, fs).length).toBe(2);
  });

  it("skips non-.md files", () => {
    const fs = makeFS(root, {
      "my-skill": { "script.ts": null, "data.json": null },
    });
    expect(collectSkillFiles(root, fs)).toEqual([]);
  });

  it("skips node_modules", () => {
    const fs = makeFS(root, {
      "my-skill": { "SKILL.md": null },
      "node_modules": { "x.md": null },
    });
    expect(collectSkillFiles(root, fs).length).toBe(1);
  });
});

describe("collectPromptFiles", () => {
  const root = "/prompts";

  it("collects .md and .txt files", () => {
    const fs = makeFS(root, {
      "custom": { "system.md": null, "inline.txt": null },
    });
    expect(collectPromptFiles(root, fs).length).toBe(2);
  });

  it("skips non-.md/.txt files", () => {
    const fs = makeFS(root, {
      "custom": { "script.ts": null, "data.json": null },
    });
    expect(collectPromptFiles(root, fs)).toEqual([]);
  });

  it("skips dot-directories", () => {
    const fs = makeFS(root, {
      ".cache": { "x.md": null },
      "custom": { "prompt.md": null },
    });
    expect(collectPromptFiles(root, fs).length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
//  isDocEmpty
// ────────────────────────────────────────────────────────────────────

function emptyDoc(): PiConfigDocument {
  return {
    settings: {},
    models: {},
    extensions: {},
    skills: {},
    prompts: {},
    localOnly: {},
    lastSync: {},
  };
}

describe("isDocEmpty", () => {
  it("returns true on a freshly-shaped doc", () => {
    expect(isDocEmpty(emptyDoc())).toBe(true);
  });

  it("ignores localOnly and lastSync (those aren't sync content)", () => {
    const doc = emptyDoc();
    doc.localOnly["extensions/foo"] = ["hostA"];
    doc.lastSync["hostA"] = 123;
    expect(isDocEmpty(doc)).toBe(true);
  });

  it("returns false when any collection has an entry", () => {
    for (const k of ["extensions", "skills", "prompts"] as const) {
      const doc = emptyDoc();
      (doc[k] as Record<string, unknown>)["x"] = { content: "y", installedAt: 1 };
      expect(isDocEmpty(doc)).toBe(false);
    }
  });

  it("returns false when settings or models have keys", () => {
    const a = emptyDoc(); a.settings = { theme: "dark" } as any;
    const b = emptyDoc(); b.models = { "claude-opus": {} } as any;
    expect(isDocEmpty(a)).toBe(false);
    expect(isDocEmpty(b)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
//  partitionPendingChanges
// ────────────────────────────────────────────────────────────────────

describe("partitionPendingChanges", () => {
  const cfg: SyncConfig = { ...DEFAULT_SYNC_CONFIG };

  function withEntry(doc: PiConfigDocument, key: string, entry: any) {
    const subdir = key.split("/")[0] as "extensions" | "skills" | "prompts";
    (doc[subdir] as Record<string, unknown>)[key] = entry;
    return doc;
  }

  it("routes existing files into `present`", () => {
    const out = partitionPendingChanges(
      ["extensions/foo/index.ts"],
      cfg,
      emptyDoc(),
      () => true,
    );
    expect(out.present).toEqual(["extensions/foo/index.ts"]);
    expect(out.deletions).toEqual([]);
    expect(out.blockedDeletions).toBe(false);
  });

  it("routes missing files with a live doc entry into `deletions`", () => {
    const doc = withEntry(emptyDoc(), "extensions/foo/index.ts", {
      content: "x", installedAt: 1,
    });
    const out = partitionPendingChanges(
      ["extensions/foo/index.ts"],
      cfg,
      doc,
      () => false,
    );
    expect(out.deletions).toEqual(["extensions/foo/index.ts"]);
    expect(out.present).toEqual([]);
  });

  it("ignores missing files with no doc entry (re-delete is a no-op)", () => {
    const out = partitionPendingChanges(
      ["extensions/foo/index.ts"],
      cfg,
      emptyDoc(),
      () => false,
    );
    expect(out.deletions).toEqual([]);
    expect(out.present).toEqual([]);
  });

  it("ignores missing files whose doc entry is already tombstoned", () => {
    const doc = withEntry(emptyDoc(), "extensions/foo/index.ts", {
      content: "x", installedAt: 1,
      deletedAt: Date.now() - 1000, deletedBy: "hostA",
    });
    const out = partitionPendingChanges(
      ["extensions/foo/index.ts"],
      cfg,
      doc,
      () => false,
    );
    expect(out.deletions).toEqual([]);
  });

  it("never tombstones settings.json or models.json — whole-file JSON treats absence as no-op", () => {
    const out = partitionPendingChanges(
      ["settings.json", "models.json"],
      cfg,
      emptyDoc(),
      () => false,
    );
    expect(out.deletions).toEqual([]);
    expect(out.present).toEqual([]);
  });

  it("respects the sync-category toggles", () => {
    const noSkills: SyncConfig = { ...cfg, syncSkills: false };
    const out = partitionPendingChanges(
      ["skills/foo/SKILL.md", "extensions/bar/index.ts"],
      noSkills,
      emptyDoc(),
      () => true,
    );
    expect(out.present).toEqual(["extensions/bar/index.ts"]);
  });

  it("trips blockedDeletions past MASS_DELETE_LIMIT", () => {
    const doc = emptyDoc();
    const keys: string[] = [];
    for (let i = 0; i < MASS_DELETE_LIMIT + 1; i++) {
      const k = `extensions/ext${i}/index.ts`;
      keys.push(k);
      withEntry(doc, k, { content: "x", installedAt: 1 });
    }
    const out = partitionPendingChanges(keys, cfg, doc, () => false);
    expect(out.deletions.length).toBe(MASS_DELETE_LIMIT + 1);
    expect(out.blockedDeletions).toBe(true);
  });

  it("does not trip the brake exactly at the limit", () => {
    const doc = emptyDoc();
    const keys: string[] = [];
    for (let i = 0; i < MASS_DELETE_LIMIT; i++) {
      const k = `extensions/ext${i}/index.ts`;
      keys.push(k);
      withEntry(doc, k, { content: "x", installedAt: 1 });
    }
    const out = partitionPendingChanges(keys, cfg, doc, () => false);
    expect(out.deletions.length).toBe(MASS_DELETE_LIMIT);
    expect(out.blockedDeletions).toBe(false);
  });

  it("skips unsupported keys (path traversal, unsupported extensions, skip-dirs)", () => {
    const out = partitionPendingChanges(
      [
        "extensions/../../etc/passwd",     // path traversal
        "extensions/foo/runtime.db",        // unsupported suffix
        "extensions/foo/node_modules/x.js", // skip-dir
        "extensions/pi-sync/index.ts",      // pi-sync itself never syncs
      ],
      cfg,
      emptyDoc(),
      () => true,
    );
    expect(out.present).toEqual([]);
    expect(out.deletions).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  collectSessionFiles
// ══════════════════════════════════════════════════════════════════════

describe("collectSessionFiles", () => {
  const hostname = "test-host";

  it("returns empty for non-existent dir", () => {
    const noDir = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    expect(collectSessionFiles("/nonexistent", hostname, noDir)).toEqual([]);
  });

  it("collects .jsonl files under --...-- dirs and maps keys", () => {
    const readdir = makeFS("/fake/sessions", {
      "--home-chris--": {
        "2026-01-01T00-00.jsonl": null,
        "2026-01-02T00-00.jsonl": null,
        "notes.txt": null,
        nested: {
          "deep.jsonl": null,
        },
      },
      "--home-chris-dev--": {
        "2026-06-01T00-00.jsonl": null,
      },
      "some-host-dir": {},
      "orphan.jsonl": null,
      "random.txt": null,
    });

    const result = collectSessionFiles("/fake/sessions", hostname, readdir);

    expect(result).toContain(`sessions/${hostname}/--home-chris--/2026-01-01T00-00.jsonl`);
    expect(result).toContain(`sessions/${hostname}/--home-chris--/2026-01-02T00-00.jsonl`);
    expect(result).toContain(`sessions/${hostname}/--home-chris--/nested/deep.jsonl`);
    expect(result).toContain(`sessions/${hostname}/--home-chris-dev--/2026-06-01T00-00.jsonl`);
    // Non --...-- dirs are skipped
    expect(result).not.toContain(expect.stringContaining("some-host-dir"));
    // Non-.jsonl files are skipped
    expect(result).not.toContain("notes.txt");
    // Top-level orphan .jsonl (not under --...-- dir) is skipped
    expect(result).not.toContain("orphan.jsonl");
  });
});

describe("session transport keys", () => {
  it("namespaces native session paths by source hostname", () => {
    expect(sessionKeyForLocalRelative(
      "--home-chris--/session.jsonl",
      "laptop",
    )).toBe("sessions/laptop/--home-chris--/session.jsonl");
  });

  it.each([
    "remote-host/session.jsonl",
    "orphan.jsonl",
    "--home-chris--/notes.txt",
    "--home-chris--/../escape.jsonl",
  ])("rejects non-native outbound path %s", (relative) => {
    expect(sessionKeyForLocalRelative(relative, "laptop")).toBeNull();
  });

  it("accepts a remote hostname-namespaced session key", () => {
    expect(validateIncomingSessionKey(
      "sessions/desktop/--home-chris--/session.jsonl",
      "laptop",
    )).toBe("sessions/desktop/--home-chris--/session.jsonl");
  });

  it.each([
    "sessions/laptop/--home-chris--/session.jsonl",
    "sessions/desktop/session.jsonl",
    "sessions/desktop/not-native/session.jsonl",
    "sessions/desktop/--home--/notes.txt",
    "sessions/desktop/--home--/../escape.jsonl",
    "/sessions/desktop/--home--/session.jsonl",
  ])("rejects unsafe or echo-prone incoming key %s", (key) => {
    expect(validateIncomingSessionKey(key, "laptop")).toBeNull();
  });
});
