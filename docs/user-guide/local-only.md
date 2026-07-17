# Local-only files

Some files shouldn't leave a machine. Built-in sensitive paths such as
`auth.json` are excluded. For extensions, skills, and prompts, the `localOnly`
map lists which hosts may retain a materialized file or directory prefix.
Matching content is removed from the live shared document and future imports
are blocked while the rule exists.

Local-only is prospective, not retroactive cryptographic erasure. If content
was already synced before the rule was added, old Automerge storage or backups
may still contain it.

`extensions/pi-sync` is automatically excluded from sync.

## Commands

- `/sync:local-only list` — list current pins
- `/sync:local-only add <path> [host]` — pin a path to one allowed host
- `/sync:local-only remove <path>` — remove a pin

See [Commands](commands.md) for the full command surface.

## How it works

Internally, `localOnly` is a map from path prefix to a list of allowed hostnames.
Pure resolution logic lives in `lib.ts` and is unit-tested. Longest-prefix wins;
an empty allowlist means "nobody". Disallowed existing copies are moved into
pi-sync trash, while removing a rule republishes the current host's local copy.
