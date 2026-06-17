# pi-sync — Protocol & Architecture

Canonical reference for the pi-sync protocol, data model, and trust assumptions.
Last updated: 2026-06-17.

---

## Overview

pi-sync keeps your pi coding agent setup — settings, models, extensions, skills,
prompts, and session history — in sync across your own machines. It's a
local-first, P2P sync extension backed by Automerge CRDTs.

- **No central server.** Every peer runs a lightweight WebSocket server and
  dials outbound to every other peer.
- **Works offline.** Each machine has a full CRDT copy and edits independently.
  Changes merge when peers reconnect.
- **Tailscale-friendly.** The standard setup is across a Tailscale tailnet.
  A `/sync:peers scan` command auto-discovers other pi-sync peers on the network.
- **Fully local.** The peer list, storage, and document identity are plain files
  on disk. No accounts, no sign-up, no external services.

### 30-second summary

```
Machine A                         Machine B
┌──────────────┐                  ┌──────────────┐
│ ~/.pi/agent  │                  │ ~/.pi/agent  │
│      │       │                  │      │       │
│  fs.watch    │                  │  fs.watch    │
│      │       │                  │      │       │
│ Automerge ──── WebSocket ──── Automerge        │
│   doc    │    (Tailscale)        doc    │       │
│      │   export via             │   export via  │
│  atomic      change listener    atomic          │
│  writes     (smart patches)     writes          │
└──────────────┘                  └──────────────┘
```

---

## Identity model

**Hostname is the peer identity.** `os.hostname()` identifies the machine in
`lastSync` timestamps, `localOnly` allowlists, `deletedBy` audit trail, and
peer matching. There is no keypair or cryptographic identity — pi-sync relies
on the network layer (Tailscale) for authenticity and assumes you control all
machines in the sync cluster.

Peer strings on the wire are `"host:port"` (e.g., `"laptop.tailnet.ts.net:3030"`).
The helper `peerHost()` strips the port to extract just the hostname for matching.

---

## Document schema

A single Automerge document holds all synced state for the cluster. Its
top-level shape:

```typescript
interface PiConfigDocument {
  settings: Record<string, unknown>;        // per-key merge
  models: Record<string, unknown>;           // per-key merge
  extensions: Record<string, SyncedFile>;    // extension files by key
  skills: Record<string, SyncedFile>;        // skill markdown files by key
  prompts: Record<string, SyncedFile>;       // prompt markdown/txt files by key
  sessions: Record<string, SyncedFile>;      // session .jsonl files by key
  localOnly: Record<string, string[]>;       // fileKey → allowed hosts
  lastSync: Record<string, number>;          // hostname → epoch ms
}
```

### SyncedFile entry

```typescript
interface SyncedFile {
  content: string;          // file contents (may be ImmutableString in Automerge)
  installedAt: number;      // epoch ms of first import
  source?: string;          // (reserved)
  deletedAt?: number;       // epoch ms of soft-delete (absence = live)
  deletedBy?: string;       // hostname that initiated the delete
}
```

### FileKey format

File keys are forward-slash-separated paths relative to `~/.pi/agent`:

```
settings.json                  → settings
models.json                    → models
extensions/<name>/index.ts     → extensions
extensions/<name>/package.json → extensions
skills/<name>/SKILL.md         → skills
prompts/<name>.md              → prompts
sessions/<host>/<cwd>/*.jsonl  → sessions
```

Session keys include the source hostname — e.g.,
`sessions/macbook/--Users-chris--/2026-06-01.jsonl` — so remote sessions
land in a hostname directory on every peer, clearly distinguishable from
local sessions. The local-export guard skips sessions whose original source
file (under the `--...--` CWD directory) still exists, preventing duplicate
copies of our own sessions on disk.

The subdirectory prefix determines the section of the document the file maps to.
`settings.json` and `models.json` are per-key merged into their respective
document sections rather than stored as SyncedFile entries.

### Local-only

Entries under `localOnly` pin specific files to specific hostnames. A file
matching a local-only rule is never synced to other peers. The `pi-sync`
extension itself is always local-only (hardcoded at doc creation):

```json
{
  "localOnly": {
    "extensions/pi-sync": ["mylaptop"]
  }
}
```

The `shouldSync()` function gates all import and export paths on both the
category toggle and the local-only check.

---

## Sync lifecycle

### Create (first machine)

1. User installs pi-sync. On first `/reload`, no `doc-url` file exists.
2. `initRepo()` creates a fresh Automerge document with empty collections.
3. `collectAllFiles()` walks `~/.pi/agent` and imports every syncable file
   into the doc, one at a time to avoid WASM capacity overflow.
4. The document URL is written atomically to `~/.config/pi-sync/doc-url`.
5. The watcher, purge timer, and peer probing loops start.

### Join (subsequent machines)

1. User runs `/sync:peers add <host:port>` and `/sync:import <url>`.
2. On next `/reload`, `initRepo()` finds a `doc-url` file and calls
   `repo.find(url)`.
3. `whenReady()` resolves once the full snapshot has loaded from peers.
4. Posts the local machine's files into the doc so peers learn about any
   extensions/skills this machine has that they don't.
5. One bulk export writes the merged tree to disk, then the change listener
   takes over for incremental updates.

### Unlink

`/sync:unlink` shuts down the repo and deletes the `doc-url` file. The next
`/reload` starts fresh with a new document. The old Automerge storage is left
on disk; the cluster continues without the unlinked machine.

---

## Import / Export (data flow)

```
Local file change → fs.watch → 500ms debounce → pendingChanges
                                                      │
                                              flushPendingChanges()
                                              importFile(doc, fileKey)
                                                      │
                                              Automerge doc change
                                                      │
                                              sync to peers ─────────┐
                                                      │              │
                                              change listener       │
                                              dirtyKeysFromPatches()│
                                                      │              │
                                              exportFile(doc, key)  │
                                              atomicWrite(path,      │
                                                unwrapContent)       │
                                                      │              │
                                              installMissingDeps()   │
                                                                     │
Remote change ◄──────── doc change arrives ◄─── Automerge sync ◄─────┘
```

### Import

`importFile()` reads the file at `~/.pi/agent/<fileKey>` and writes it into the
Automerge document. For `settings.json` and `models.json`, a per-key merge
(`applyJsonMergeInPlace`) preserves CRDT semantics — two peers editing different
keys merge cleanly instead of one overwriting the other. For extensions, skills,
and prompts, the SyncedFile entry is created or updated with the file content.

### Smart export

The change listener extracts affected fileKeys from the patch list via
`dirtyKeysFromPatches()` and only exports those keys, rather than re-exporting
the entire document on every change. A full export only happens on initial
join.

### Atomic writes

All filesystem writes use `atomicWriteFile()`: write to a temp file in the same
directory, then POSIX `rename`. Readers never observe a half-written file.

### Export guard

An `exporting` flag (and a `suppressExportDepth` counter for nested calls)
suppresses the watcher while exporting. Without this, writing a file to disk
triggers the watcher, which imports the just-written file back into the doc,
creating an infinite loop.

### Dependency install

After exporting extension files, pi-sync checks whether the extension directory
has a `package.json` with dependencies but no `node_modules/`. If so, it runs
`npm install --ignore-scripts` as a fire-and-forget background process so pi
doesn't fail to load the extension on the next `/reload`.

---

## CRDT merge semantics

pi-sync uses [Automerge](https://automerge.org/) v3. The single document
approach means every peer has eventual consistency without coordination.

### ImmutableString

Automerge may return content fields as `ImmutableString { val: "..." }` instead
of a plain string. All readers must use `unwrapContent()` from `lib.ts`, which
handles both shapes transparently.

### Per-key settings merge

When `settings.json` or `models.json` is imported, `applyJsonMergeInPlace()`
writes individual keys rather than replacing the whole object. Two peers editing
different keys concurrently will merge cleanly. `mergeSettingsIntoDoc()` is a
pure comparison helper for tests and non-proxy callers.

### Last-write-wins for file content

Extension, skill, and prompt file contents use the SyncedFile structure. When
two peers concurrently modify the same file, the last write to the Automerge
doc wins. For configuration files (designed for the user), this is acceptable
because the user is the same person on different machines.

---

## Peer discovery & connection

### WebSocket server

Each peer listens on `config.port` (default `3030`) via a `ws.WebSocketServer`.
Inbound connections are routed into the Automerge Repo through `NodeWSServerAdapter`.

### WebSocket client

Each peer opens outbound connections to every configured peer via
`WebSocketClientAdapter`. The adapter set is constructed once during
`initRepo()` and frozen until the next `/reload`.

### TCP probing

A periodic probe (every 15 seconds) tests TCP reachability of each configured
peer. `/sync:peers list` shows 🟢 for WS-connected, 🔵 for TCP-reachable,
and 🔴 for offline.

### Tailscale scan

`/sync:peers scan` calls `tailscale status --json`, extracts online peers
on the same tailnet, and probes each for an open pi-sync port. Any that
respond are listed for the user to add.

---

## Tombstone lifecycle

Deletes go through three stages: soft tombstone → trash file → TTL purge.

### Soft delete

When the watcher detects a file has been removed from disk:

1. `deletedAt` and `deletedBy` are set on the SyncedFile entry. **The entry
   stays in the document.**
2. On the originating machine, the file is moved to `~/.pi/agent/.trash/`.
3. On other peers, the export path sees the tombstone and moves their local
   copy to `.trash/` as well.

This prevents an accidental delete on one machine from cluster-wide wiping
a recoverable file.

### Mass-delete brake

If more than `MASS_DELETE_LIMIT` (5) files vanish in a single watcher flush,
the entire deletion batch is aborted. No tombstones are created for those
missing files. Add/update imports in the same flush are still applied.

This protects against wholesale `rm -rf` accidents (e.g., cleaning node_modules
in a parent directory that catches the extensions tree).

### TTL purge

Every 24 hours, the purge timer scans for tombstones where `deletedAt` is
older than `TOMBSTONE_TTL_MS` (14 days). Those entries are hard-deleted from
the document, and their trash copies are removed from disk.

### User control

| Command | Effect |
|---|---|
| `/sync:trash list` | Show all tombstoned entries |
| `/sync:trash restore <key>` | Move `.trash/<key>` back to its original location and clear the tombstone |
| `/sync:trash empty <key>` | Hard-delete one tombstone immediately |
| `/sync:trash empty` | Hard-delete all tombstones past the 14-day TTL |

---

## Crash recovery

### Automerge wasm crash guard

Automerge's WASM binary can throw non-recoverable errors (e.g., `PatchLogMismatch`,
`recursive use of an object`). pi-sync installs a crash guard on
`process.prependListener("uncaughtException")` that:

1. Filters for Automerge-specific error signatures.
2. Stubs `process.exit` so pi's own handler doesn't kill the process.
3. Moves `~/.pi/am-storage/` to `~/.pi/am-storage.corrupt.<timestamp>/`.
4. Notifies the user to run `/reload`.

Network errors (`ECONNREFUSED`, `ETIMEDOUT`, etc.) and WebSocket abort errors
from orphaned connections are also caught and suppressed — these are expected
when peers go offline and should not crash the agent.

### WS / network patch

Two monkey-patches prevent crash loops from orphaned sockets:

1. **net.Socket.prototype.connect** — adds a no-op error listener to sockets
   targeting known pi-sync peers, so orphaned TCP connections that time out
   don't throw `uncaughtException`.
2. **ws.WebSocket.prototype.close** — adds a no-op error listener before
   closing CONNECTING sockets, preventing `WebSocket was closed before the
   connection was established` crashes during adapter reconnect.

### Storage quarantine

On Automerge crash, the storage directory is renamed rather than deleted.
The user can recover manually or let the cluster re-sync.

### Standby watchdog

When a second pi instance starts (e.g., a new terminal), the extension enters
**standby mode**: it probes the local sync port and waits for the primary
instance to exit. Once the port becomes available, it takes over with a
randomized jitter (50–500 ms) to prevent multiple standbys from racing for
the same port. This ensures exactly one sync node per machine, even with
multiple concurrent pi sessions.

---

## Trust model

### What pi-sync protects

- **File integrity.** Atomic writes prevent corrupt partial files.
- **Delete safety.** Two-phase tombstone model + mass-delete brake prevent
  accidental cluster-wide data loss.
- **Cluster liveness.** Crash guard, network error suppression, and standby
  watchdog keep the sync layer alive despite Automerge panics and peer churn.
- **Machine isolation.** Local-only entries keep machine-specific files
  (auth, caches) from leaking to peers.

### What pi-sync does NOT protect (declared honestly)

- **No cryptographic authentication.** Peers are trusted by hostname. An
  attacker who can spoof a peer on the network can inject data. Mitigation:
  run over Tailscale or an equivalently trusted network.
- **No end-to-end encryption.** Document content travels as plain Automerge
  sync messages over WebSocket. TLS is not enforced at the pi-sync layer
  (relies on Tailscale's WireGuard or your own TLS termination).
- **No authorization boundaries.** All peers in the cluster have full read/write
  access to the entire document. pi-sync assumes all machines belong to the
  same user.
- **No data-at-rest encryption.** The Automerge storage at `~/.pi/am-storage/`
  is plain files on disk. Full-disk encryption (FileVault, LUKS) is recommended.

### Threat model

| Adversary | Capability | Protected? |
|---|---|---|
| Unauthorized device on tailnet | Inject sync messages | ❌ No (relies on Tailscale auth) |
| Network observer (off-tailnet) | Sniff traffic | ✅ Yes (Tailscale WireGuard) |
| Accidental local `rm -rf` | Delete synced files | ✅ Yes (mass-delete brake) |
| Accidental delete of one file | Cluster-wide wipe | ✅ Yes (tombstone model) |
| Automerge wasm panic | Crash pi process | ✅ Yes (crash guard) |
| Disk corruption | Corrupt Automerge storage | ⚠️ Partial (quarantine + re-sync from peers) |
| Two peers edit same JSON key | Conflict | ❌ Last-write-wins |

---

## Failure modes

| Failure | Behaviour |
|---|---|
| Peer offline | Outbound connection fails; other peers continue normally. `initInProgress` guard prevents `/new` races during async init |
| Peer returns | Automerge syncs missing changes automatically on reconnect |
| Port conflict (`EADDRINUSE`) | WS server logs error. User must edit `config.json` to change port and `/reload` |
| Automerge wasm panic | Storage quarantined; user notified; `/reload` re-inits from peers |
| `rm -rf ~/.pi/agent/extensions` | Mass-delete brake triggers; no tombstones created; user warned |
| Tailscale not installed | `/sync:peers scan` fails gracefully with a message about the missing CLI |
| `/new` during async init | `initInProgress` flag blocks re-entry into `initRepo()` |
| Multiple pi instances (standby) | Standby watchdog ensures exactly one active sync node per machine |
| Missing extension dependencies | `installMissingExtensionDeps()` runs `npm install` in background on export |

---

## Configuration

`~/.config/pi-sync/config.json`:

```json
{
  "port": 3030,
  "peers": ["laptop.tailnet.ts.net:3030"],
  "syncSettings": true,
  "syncModels": true,
  "syncExtensions": true,
  "syncSkills": true,
  "syncPrompts": true,
  "syncSessions": true
}
```

### Companion files

| Path | Purpose |
|---|---|
| `~/.config/pi-sync/doc-url` | Automerge document URL (join key) |
| `~/.config/pi-sync/disabled` | Presence of this file disables pi-sync entirely |

### Environment variable

| Variable | Effect |
|---|---|
| `PI_SYNC_DISABLED=1` | Disable pi-sync without uninstalling |

---

## Roadmap

### Short term

- E2E encryption of document payload (Curve25519 + ChaCha20-Poly1305
  between peers)
- Auth key material at `~/.pi/agent/auth.json` as explicitly excluded from
  sync (hardened beyond filename filter)
- `sync:ignore` patterns (e.g., exclude `node_modules/` within extension dirs)

### Medium term

- Binary file sync (wasm binaries, compiled artifacts) for extensions
- Selective sync — sync some extensions to laptop but not desktop
- Diff viewer for conflict resolution UI

### Long term

- Beyond-config sync: session sharing (live collaborative pi sessions)
- Integration with pi's built-in multi-agent primitives
