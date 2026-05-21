# pi-sync

P2P sync for pi coding agent settings using [Automerge](https://automerge.org/) CRDTs over
WebSocket — typically run across machines on the same [Tailscale](https://tailscale.com/)
tailnet. No central server required; each peer runs a lightweight WS server and connects
to every other peer. Works offline and merges automatically when reconnected.

## What gets synced

| Category   | Toggle             | Files                                                  |
|------------|--------------------|---------------------------------------------------------|
| Settings   | `syncSettings`     | `~/.pi/agent/settings.json`                             |
| Models     | `syncModels`       | `~/.pi/agent/models.json`                              |
| Extensions | `syncExtensions`   | `~/.pi/agent/extensions/*` (code + assets, except pi-sync) |
| Skills     | `syncSkills`       | `~/.pi/agent/skills/**/*.md`                           |
| Prompts    | `syncPrompts`      | `~/.pi/agent/prompts/**/*.md`, `**/*.txt`              |

The `pi-sync` extension itself is **never** synced. It is skipped by file
collection and sync gating, and the document is also pinned to `localOnly` on
creation because its WASM binaries and peer config are machine-specific.

## Setup

### 1. Install dependencies

```bash
cd ~/.pi/agent/extensions/pi-sync
npm install
```

### 2. Configure peers

Edit `~/.config/pi-sync/config.json`:

```json
{
  "port": 3030,
  "peers": [
    "laptop.tailnet.ts.net:3030",
    "desktop.tailnet.ts.net:3030"
  ]
}
```

Or use in-app commands (see below).

### 3. Pair machines

**First machine** (creator):

```
/sync:info
```

Copy the `automerge:…` URL.

**Second machine** (joiner):

```
/sync:peers add <first-machine-hostname>:3030
/sync:import <automerge-url>
/reload
```

After reload, synced extensions, skills, settings, models, and prompts from the
first machine will appear on the second. Changes propagate both ways automatically.

## Commands

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

## Architecture

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

- **Automerge Repo** — manages CRDT documents on each machine, persisted to
  `~/.pi/am-storage/` via `NodeFSStorageAdapter`.
- **WebSocket server** — each peer listens on the configured port; inbound
  connections are routed into the repo by `NodeWSServerAdapter`.
- **WebSocket client** — each peer opens outbound connections to every
  configured peer via `WebSocketClientAdapter`.
- **File watcher** — `fs.watch` on `~/.pi/agent` detects local edits
  and imports them into the CRDT document (debounced at 500ms).
- **Change listener** — when a synced document change arrives, it exports the
  touched document keys back to the filesystem.
- **Export guard** — during an export, the watcher is suppressed to avoid
  re-importing freshly written files (feedback loop prevention).
- **Delete guard** — file removals are soft-deleted as tombstones first; large
  delete bursts are blocked, and old tombstones are purged after the TTL.

### Data flow

```
Local edit → fs.watch → debounce → importFile() → Automerge doc
                                                      │
                                             (sync to peers)
                                                      │
Remote change ← exportFile() ← fs.writeFile ← Automerge doc
```

## Local-only files

Some files shouldn't leave a machine. Built-in sensitive paths such as
`auth.json` and `sessions/` are ignored by the watcher; for synced paths, the
`localOnly` map in the CRDT document lists which hosts are allowed to import or
export a file or directory prefix. If your hostname isn't in the allowlist, the
path stays local.

`extensions/pi-sync` is automatically excluded from sync.

## Deletes and trash

Synced extension, skill, and prompt removals are first recorded as tombstones
and local files are moved under `~/.pi/agent/.trash/`. This gives peers a chance
to observe the delete without immediately destroying recoverable content.

Use `/sync:trash` to review tombstones, `/sync:trash restore <path>` to undo one,
and `/sync:trash empty <path>` to finalize one. Tombstones older than the TTL are
purged automatically.

## Configuration reference

`~/.config/pi-sync/config.json`:

```jsonc
{
  "port": 3030,              // WebSocket port to listen on
  "peers": [                 // Other machines to connect to
    "host1.tailnet.ts.net:3030"
  ],
  "syncSettings": true,      // Sync settings.json
  "syncModels": true,        // Sync models.json
  "syncExtensions": true,    // Sync extension code
  "syncSkills": true,        // Sync skill SKILL.md files
  "syncPrompts": true        // Sync prompt files
}
```

## Data directory

- `~/.config/pi-sync/config.json` — sync config
- `~/.config/pi-sync/doc-url` — Automerge document URL (join key)
- `~/.pi/am-storage/` — Automerge repo storage (CRDT data)
- `~/.pi/agent/.trash/` — soft-deleted files awaiting TTL purge
