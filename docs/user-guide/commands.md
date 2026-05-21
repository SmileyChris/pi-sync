# Commands

All commands are slash-commands inside pi.

| Command                    | Description                                          |
|----------------------------|------------------------------------------------------|
| `/sync:status`             | Show sync state, peers, document info                |
| `/sync:info`               | Show your document URL (share to pair)               |
| `/sync:invite`             | Alias for `/sync:info`                               |
| `/sync:import <url>`       | Join an existing sync network                       |
| `/sync:unlink`             | Detach from the network, start fresh                 |
| `/sync:peers list`         | List configured peers (with connectivity)            |
| `/sync:peers add <host:port>` | Add a peer                                         |
| `/sync:peers remove <host>`   | Remove a peer                                      |
| `/sync:peers scan`         | Auto-discover pi-sync peers via Tailscale            |
| `/sync:config`             | Interactive panel to toggle sync categories          |
| `/sync:local-only list`       | List files pinned as local-only                   |
| `/sync:local-only add <path> [host]` | Pin a path to one allowed host            |
| `/sync:local-only remove <path>`     | Remove local-only pin                      |
| `/sync:trash list`           | List soft-deleted files (tombstones)              |
| `/sync:trash restore <path>`  | Restore a tombstoned file from trash              |
| `/sync:trash empty <path>`    | Finalize deletion of one tombstone                |
| `/sync:trash empty`           | Finalize all tombstones past TTL (14 days)        |

For a deep-linkable per-command reference, see [Reference → Commands](../reference/commands.md).
