# pi-sync

P2P sync for pi coding agent settings using [Automerge](https://automerge.org/) CRDTs over WebSocket — typically run across machines on the same [Tailscale](https://tailscale.com/) tailnet. No central server required; each peer runs a lightweight WS server and connects to every other peer. Works offline and merges automatically when reconnected.

## What gets synced

| Category   | Toggle             | Files                                                  |
|------------|--------------------|---------------------------------------------------------|
| Settings   | `syncSettings`     | `~/.pi/agent/settings.json`                             |
| Models     | `syncModels`       | `~/.pi/agent/models.json`                              |
| Extensions | `syncExtensions`   | `~/.pi/agent/extensions/*` (code + assets, except pi-sync) |
| Skills     | `syncSkills`       | `~/.pi/agent/skills/**/*.md`                           |
| Prompts    | `syncPrompts`      | `~/.pi/agent/prompts/**/*.md`, `**/*.txt`              |

The `pi-sync` extension itself is **never** synced. It is skipped by file collection and sync gating, and the document is also pinned to `localOnly` on creation because its WASM binaries and peer config are machine-specific.

## Next steps

- New here? Start with [Install](get-started/install.md), then [Pair machines](get-started/pair-machines.md).
- Looking for a command? See [Commands](user-guide/commands.md) or the full [Reference → Commands](reference/commands.md).
- Curious how it works? Read [Architecture](concepts/architecture.md) and [Data flow](concepts/data-flow.md).
- Contributing? Start with [Project layout](developer/project-layout.md) and [Key rules](developer/key-rules.md).
