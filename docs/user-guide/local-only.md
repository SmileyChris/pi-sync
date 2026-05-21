# Local-only files

Some files shouldn't leave a machine. Built-in sensitive paths such as `auth.json` and `sessions/` are ignored by the watcher; for synced paths, the `localOnly` map in the CRDT document lists which hosts are allowed to import or export a file or directory prefix. If your hostname isn't in the allowlist, the path stays local.

`extensions/pi-sync` is automatically excluded from sync.

## Commands

- `/sync:local-only list` — list current pins
- `/sync:local-only add <path> [host]` — pin a path to one allowed host
- `/sync:local-only remove <path>` — remove a pin

See [Commands](commands.md) for the full command surface.

## How it works

Internally, `localOnly` is a map from path prefix to a list of allowed hostnames. Pure resolution logic (`isLocalOnly`, `isLocalOnlyByMap`) lives in `lib.ts` and is unit-tested. Longest-prefix wins; an empty allowlist means "nobody".
