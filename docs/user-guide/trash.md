# Trash

Synced extension, skill, and prompt removals are first recorded as *tombstones* and the local files are moved under `~/.pi/agent/.trash/`. This gives peers a chance to observe the delete without immediately destroying recoverable content.

## Commands

- `/sync:trash list` — review tombstones
- `/sync:trash restore <path>` — undo a tombstone
- `/sync:trash empty <path>` — finalize one tombstone now
- `/sync:trash empty` — finalize all tombstones past the 14-day TTL

Tombstones older than the TTL are purged automatically.

## See also

- [Tombstones](../concepts/tombstones.md) — the model, the mass-delete brake, and the rationale.
