# Tombstones

A delete in pi-sync is two phases: a soft *tombstone* on the doc, and an eventual hard purge after the TTL.

## Tombstone model

When the watcher sees a file vanish on disk, the doc entry for that key is **not** removed. Instead:

- `deletedAt` is set to the current timestamp.
- `deletedBy` is set to `os.hostname()`.

The export path moves the local file to `~/.pi/agent/.trash/`. The doc entry stays until either:

- The user runs `/sync:trash empty <path>` to finalize, or
- The TTL (14 days) elapses and an automatic purge removes it.

This prevents an accidental delete on one peer from cluster-wide wiping a recoverable file.

## Mass-delete brake

If more than `MASS_DELETE_LIMIT` (5) files vanish in a single watcher flush, the deletion pass is **aborted**. No tombstones are created for those missing files, though present add/update imports in the same flush may still be applied. The user must restore the files on disk, or restore and remove a small, deliberate batch if they intend to propagate deletes.

This brake exists because a wholesale `rm -rf` of `~/.pi/agent/extensions` (e.g., an accidental clean of node_modules in a parent dir) would otherwise tombstone everything across the cluster.

## See also

- User-facing view: [Trash](../user-guide/trash.md).
- The relevant code-of-conduct rules for contributors: [Key rules](../developer/key-rules.md).
