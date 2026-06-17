# Commands

Every pi-sync slash-command, in lookup form. For an at-a-glance table, see [User Guide → Commands](../user-guide/commands.md).

## `/sync:status`

Show sync state, peers, and document info.

## `/sync:info`

Show your document URL (share to pair another machine).

## `/sync:import <url>`

Join an existing sync network using a doc URL printed by `/sync:info` on another machine.

## `/sync:unlink`

Detach from the network and start fresh. The local doc URL is forgotten.

## `/sync:peers list`

List configured peers with connectivity status.

## `/sync:peers add <host:port>`

Add a peer. Rejects your own hostname.

## `/sync:peers remove <host>`

Remove a peer by hostname.

## `/sync:peers scan`

Auto-discover pi-sync peers on the tailnet. Requires the `tailscale` CLI.

## `/sync:config`

Open an interactive panel to toggle sync categories (`syncSettings`, `syncModels`, `syncExtensions`, `syncSkills`, `syncPrompts`, `syncSessions`).

## `/sync:local-only list`

List files and prefixes pinned as local-only.

## `/sync:local-only add <path> [host]`

Pin a path to one allowed host (defaults to the current machine).

## `/sync:local-only remove <path>`

Remove a local-only pin.

## `/sync:trash list`

List soft-deleted files (tombstones) with their `deletedAt` and `deletedBy`.

## `/sync:trash restore <path>`

Restore a tombstoned file from `~/.pi/agent/.trash/` back into place.

## `/sync:trash empty <path>`

Finalize deletion of one tombstone (removes the doc entry and the trash copy).

## `/sync:trash empty`

Finalize all tombstones past the 14-day TTL.
