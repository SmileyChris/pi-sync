# Data flow

```
Local edit → fs.watch → debounce → importFile() → Automerge doc
                                                      │
                                             (sync to peers)
                                                      │
Remote change ← exportFile() ← fs.writeFile ← Automerge doc
```

The loop:

1. **Local edit.** A file under `~/.pi/agent` changes.
2. **Debounced import.** `fs.watch` fires; after a 500 ms debounce the watcher calls `importFile()`, which writes the file's contents into the Automerge document.
3. **CRDT sync.** Automerge Repo propagates the change to all connected peers over WebSocket.
4. **Remote export.** On each peer, the change listener identifies the touched fileKeys (via `dirtyKeysFromPatches`) and calls `exportFile()` for each, writing to disk.
5. **Guard.** While exporting, an `exporting` flag (and a `suppressExportDepth` counter for nested calls) suppresses the watcher so the just-written file is not re-imported.

For why imports do per-key merges into `settings.json` / `models.json` rather than whole-file replacement, see [CRDT model](crdt-model.md).

Session files follow a separate loop:

```
native --cwd--/*.jsonl → debounced queue → POST /session-sync
                                              │
                         sessions/<source-host>/--cwd--/*.jsonl
```

The sender retries failed deliveries and queues all native sessions on startup.
The receiver validates hostname-namespaced keys, limits request/file size,
atomically writes changed content, and ignores identical content.
