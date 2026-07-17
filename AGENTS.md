# AGENTS.md — pi-sync

pi-sync is a P2P sync extension for the pi coding agent. It uses Automerge CRDTs
over WebSocket for configuration and a bounded HTTP channel for session history
(typically over Tailscale).

For the canonical protocol reference, identity model, and trust assumptions, see
**[PROTOCOL.md](./PROTOCOL.md)**.

## Project layout

```
extensions/pi-sync/
├── PROTOCOL.md       # Canonical protocol & architecture reference
├── AGENTS.md         # This file — AI-facing rules and conventions
├── README.md         # User-facing install and quick-start docs
├── index.ts          # Extension entry point — commands, repo lifecycle, watchers
├── lib.ts            # Pure functions & types, testable without Automerge/WASM
├── lib.test.ts       # Unit tests for lib.ts (vitest)
├── state.ts          # Shared state singleton (hostname, config, runtime handles)
├── types.ts          # TypeScript interfaces (re-export / documentation)
├── footer.ts         # TUI footer widget (sync status line)
├── package.json      # Dependencies: @automerge/*, ws, vitest
├── ws-patch.test.ts  # Tests for ws/net socket monkey-patches
├── reconnect-patch.test.ts  # Tests for WebSocket reconnect handling
├── zensical.toml     # Documentation site config
└── docs/             # User-facing documentation (zensical site)
```

## Key rules

1. **Keep pure logic in `lib.ts`.** Functions that don't touch Automerge, WebSocket,
   the filesystem, or the pi API should live in `lib.ts` so they can be unit-tested.
   Import them back into `index.ts`.

2. **Don't import Automerge at the top level of index.ts.** The WASM binary causes
   issues with jiti (pi's TypeScript loader). All Automerge/WASM imports are done
   dynamically inside `initRepo()` via `await import(...)`.

3. **Tombstone model for deletions.** When a file is deleted on disk (detected by
   the watcher), the doc entry is *not* removed. Instead, `deletedAt` and `deletedBy`
   are set. The export path moves the local file to `TRASH_DIR` and the entry stays
   in the doc until TTL purge (14 days) or explicit `sync:trash empty`. This prevents
   accidental cluster-wide wipe.

4. **Mass-delete brake.** If more than `MASS_DELETE_LIMIT` (5) files vanish in a
   single watcher flush, the deletion pass is aborted and no tombstones are created
   for those missing files. Present add/update imports in the same flush may still be
   applied. The user must restore files on disk, or restore and remove a small,
   deliberate batch if they intend to propagate deletes.

5. **Export guard (`exporting` flag + `suppressExportDepth` counter).** When exporting
   or making disk-originated changes, suppress the change listener to avoid feedback
   loops. Use `withSuppressedExport()` for nested operations.

6. **ImmutableString unwrapping.** Automerge may return content fields wrapped as
   `ImmutableString { val: "..." }` instead of a plain string. Always use
   `unwrapContent()` from `lib.ts`.

7. **Per-key settings merge.** When importing `settings.json` or `models.json`,
   use `applyJsonMergeInPlace()` for per-key writes. `mergeSettingsIntoDoc()` is a
   pure comparison helper for tests and non-proxy callers. Per-key writes preserve
   CRDT semantics.

8. **`pi-sync` is always local-only.** The document is created with
   `localOnly: { "extensions/pi-sync": [hostname] }`. `shouldSync()` also
   explicitly rejects pi-sync keys via `isPiSyncExtensionKey()`.

9. **Hostname is the peer identity.** `os.hostname()` identifies the machine in
   `lastSync`, `localOnly` allowlists, `deletedBy` audit trail, and peer matching.
   Always use `peerHost()` to extract host from `"host:port"` strings.

10. **Path safety.** Always normalize fileKeys through `normalizeFileKey()` before
    filesystem operations. It rejects absolute paths, `..` traversal, null bytes,
    and other unsafe inputs. Use `piPathForKey()` / `trashPathForKey()` to derive
    absolute filesystem paths safely.

11. **Smart exports via `dirtyKeysFromPatches`.** The change listener extracts
    affected fileKeys from the patch list and only exports those keys, rather than
    re-exporting the entire document on every change.

12. **Sessions use the bounded HTTP channel, not Automerge.** Only native
    `sessions/--cwd--/**/*.jsonl` files are sent, under keys namespaced by the
    source hostname. Both sender and receiver must honor `syncSessions`; never
    rebroadcast hostname directories.

13. **First join is cluster-wins.** A joining host may contribute missing keys,
    but must not overwrite established document values. Startup deletion
    reconciliation requires a matching local baseline and must use the same
    mass-delete brake as watcher deletions.

## Testing

Run tests with:

```bash
npx vitest run        # single run
npx vitest            # watch mode
```

`lib.test.ts` covers:

| Area | Coverage |
|---|---|
| `normalizeFileKey`, `isPiSyncExtensionKey` | Path safety, reject `..`/null bytes/absolute paths |
| `fileKey`, `getSubdir` | Path mapping, Windows separators |
| `localOnlyHostsForKey`, `isLocalOnlyByMap`, `isLocalOnly` | Local-only filtering, prefix/longest-match resolution |
| `shouldSync` | Config toggle gating, pi-sync self-exclusion |
| `mergeSettingsIntoDoc`, `applyJsonMergeInPlace`, `applyJsonAdditionsInPlace` | Normal and first-join JSON merge |
| `unwrapContent`, `syncedFileContentMatches` | Content extraction (ImmutableString-safe) |
| `isTombstone`, `isPastTTL` | Soft-delete lifecycle, 14-day TTL |
| `loadConfig` | Config parsing, corrupt JSON fallback |
| `parsePeer`, `peerHost` | Peer string parsing, host extraction |
| `dirtyKeysFromPatches` | Patch → fileKey mapping, unsafe-key rejection |
| `collectExtensionFiles/SkillFiles/PromptFiles` | Directory walking, skip rules |
| `sessionKeyForLocalRelative`, `validateIncomingSessionKey` | Session namespacing and echo/path rejection |

When adding new logic, prefer to put it in `lib.ts` and add tests.

## Dependencies

- `@automerge/automerge` (^3.0) — CRDT library
- `@automerge/automerge-repo` (^2.5) — repo management (find/create docs)
- `@automerge/automerge-repo-network-websocket` (^2.5) — WebSocket transport
- `@automerge/automerge-repo-storage-nodefs` (^2.5) — Node.js filesystem storage
- `ws` (^8.18) — WebSocket server (Node.js)
- `vitest` (dev) — test runner

## Common pitfalls

- **Port conflicts**: If the configured port is in use, the WS server logs an error.
  Users must change `port` in config.json.
- **Missing tailscale**: `/sync:peers scan` requires the `tailscale` CLI. Handle the
  error gracefully and tell the user.
- **Empty document on first export**: A fresh document has zero extensions/skills/settings.
  The export path skips writing when the document appears empty (no content to export yet).
- **Self-peer**: Don't add the current hostname as a peer. The `peers add` command
  rejects it.
