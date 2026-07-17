# Architecture

```
┌──────────────┐     WebSocket      ┌──────────────┐
│  Machine A   │◄──────────────────►│  Machine B   │
│              │                    │              │
│  Automerge   │     CRDT sync      │  Automerge   │
│    Repo      │◄──────────────────►│    Repo      │
│              │                    │              │
│   fs.watch   │                    │   fs.watch   │
│   (import)   │                    │   (import)   │
│      │       │                    │      │       │
│  ~/.pi/agent │                    │  ~/.pi/agent │
└──────────────┘                    └──────────────┘
```

- **Automerge Repo** — manages CRDT documents on each machine, persisted to `~/.pi/am-storage/` via `NodeFSStorageAdapter`.
- **WebSocket server** — each peer listens on the configured port; inbound connections are routed into the repo by `NodeWSServerAdapter`.
- **WebSocket client** — each peer opens outbound connections to every configured peer via `WebSocketClientAdapter`.
- **File watcher** — `fs.watch` on `~/.pi/agent` detects local edits and imports them into the CRDT document (debounced at 500 ms).
- **Change listener** — when a synced document change arrives, it exports the touched document keys back to the filesystem.
- **Session channel** — bounded HTTP requests on the same TCP port push
  hostname-namespaced JSONL files without storing them in Automerge.
- **Export guard** — during an export, the watcher is suppressed to avoid re-importing freshly written files (feedback-loop prevention).
- **Delete guard** — file removals are soft-deleted as tombstones first; large delete bursts are blocked, and old tombstones are purged after the TTL.
- **Local baseline** — records which document keys were previously materialized
  on this host so startup can distinguish an offline deletion from a fresh join.

For the request-level view, see [Data flow](data-flow.md).
