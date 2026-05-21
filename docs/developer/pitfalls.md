# Pitfalls

## Common pitfalls

- **Port conflicts.** If the configured port is in use, the WS server logs an error. Users must change `port` in `config.json`.
- **Missing tailscale.** `/sync:peers scan` requires the `tailscale` CLI. Handle the error gracefully and tell the user.
- **Empty document on first export.** A fresh document has zero extensions/skills/settings. The export path skips writing when the document appears empty (no content to export yet).
- **Self-peer.** Don't add the current hostname as a peer. The `peers add` command rejects it.

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@automerge/automerge` | `^3.0` | CRDT library |
| `@automerge/automerge-repo` | `^2.5` | repo management (find/create docs) |
| `@automerge/automerge-repo-network-websocket` | `^2.5` | WebSocket transport |
| `@automerge/automerge-repo-storage-nodefs` | `^2.5` | Node.js filesystem storage |
| `ws` | `^8.18` | WebSocket server (Node.js) |
| `vitest` (dev) | n/a | test runner |
