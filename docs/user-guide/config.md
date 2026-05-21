# Configuration

pi-sync reads `~/.config/pi-sync/config.json`. All fields are optional; defaults are shown below.

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

For a per-field reference, see [Reference → Config schema](../reference/config-schema.md).

## Data directory

| Path | Purpose |
|---|---|
| `~/.config/pi-sync/config.json` | sync config |
| `~/.config/pi-sync/doc-url`     | Automerge document URL (join key) |
| `~/.pi/am-storage/`             | Automerge repo storage (CRDT data) |
| `~/.pi/agent/.trash/`           | soft-deleted files awaiting TTL purge |
