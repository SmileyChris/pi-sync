# Key rules

These are the project's rules of the road for contributors. The order is not strict precedence, but rules earlier in the list are touched more often.

1. **Keep pure logic in `lib.ts`.** Functions that don't touch Automerge, WebSocket, the filesystem, or the pi API should live in `lib.ts` so they can be unit-tested. Import them back into `index.ts`.

2. **Don't import Automerge at the top level of `index.ts`.** The WASM binary causes issues with jiti (pi's TypeScript loader). All Automerge/WASM imports are done dynamically inside `initRepo()` via `await import(...)`.

3. **Tombstone model for deletions.** When a file is deleted on disk (detected by the watcher), the doc entry is *not* removed. Instead, `deletedAt` and `deletedBy` are set. The export path moves the local file to `TRASH_DIR` and the entry stays in the doc until TTL purge (14 days) or explicit `sync:trash empty`. This prevents accidental cluster-wide wipe.

4. **Mass-delete brake.** If more than `MASS_DELETE_LIMIT` (5) files vanish in a single watcher flush, the deletion pass is aborted and no tombstones are created for those missing files. Present add/update imports in the same flush may still be applied. The user must restore files on disk, or restore and remove a small, deliberate batch if they intend to propagate deletes.

5. **Export guard (`state.exporting` flag + `state.suppressExportDepth` counter).** When exporting or making disk-originated changes, suppress the change listener to avoid feedback loops. Use `withSuppressedExport()` for nested operations.

5a. **All mutable runtime state lives on the `state` singleton in `state.ts`.** pi reloads extensions through jiti with `moduleCache: false`, which fully re-executes the module body on every `/new` and `/reload`. Module-level `let` bindings would reset to their defaults every time, racing against the previous instance's still-running timers, watchers, and crash-guard handlers. The shared `state` (keyed by `Symbol.for("pi-sync:state")`) gives every re-instantiation a single source of truth. The entry-point re-entry guard checks `state.standbyMode || state.handle || state.initInProgress` to decide whether the previous instance still owns the WS port.

6. **ImmutableString unwrapping.** Automerge may return content fields wrapped as `ImmutableString { val: "..." }` instead of a plain string. Always use `unwrapContent()` from `lib.ts`.

7. **Per-key settings merge.** When importing `settings.json` or `models.json`, use `applyJsonMergeInPlace()` for per-key writes. `mergeSettingsIntoDoc()` is a pure comparison helper for tests and non-proxy callers. Per-key writes preserve CRDT semantics.

8. **`pi-sync` is always local-only.** The document is created with `localOnly: { "extensions/pi-sync": [hostname] }`. `shouldSync()` also explicitly rejects pi-sync keys via `isPiSyncExtensionKey()`.

9. **Hostname is the peer identity.** `os.hostname()` identifies the machine in `lastSync`, `localOnly` allowlists, `deletedBy` audit trail, and peer matching. Always use `peerHost()` to extract host from `"host:port"` strings.

10. **Path safety.** Always normalize fileKeys through `normalizeFileKey()` before filesystem operations. It rejects absolute paths, `..` traversal, null bytes, and other unsafe inputs. Use `piPathForKey()` / `trashPathForKey()` to derive absolute filesystem paths safely.

11. **Smart exports via `dirtyKeysFromPatches`.** The change listener extracts affected fileKeys from the patch list and only exports those keys, rather than re-exporting the entire document on every change.
