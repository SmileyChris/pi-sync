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

The `pi-sync` extension itself is **never** synced — it is skipped by file collection and `shouldSync` gating, and its entries in the Automerge document are pinned to `localOnly` on creation because its WASM binaries and peer config are machine-specific.

## What is NOT synced

pi-sync only watches files under `~/.pi/agent/`. Anything outside that tree is out of scope:

- **Pi-managed data outside `~/.pi/agent/`** — databases, caches, and runtime state that live elsewhere (e.g. under `~/.pi/`) are not synced. Each machine builds its own from local sessions.
- **Extension runtime data** — generated databases, logs, caches, `node_modules/`, dot-directories, and unsupported file types are not synced. Supported code and asset files under an extension directory are synced.
- **Machine-specific config** — peer lists, port numbers, Automerge doc URLs. These live in `~/.config/pi-sync/` and are never shared.

## Next steps

- New here? Start with [Install](get-started/install.md), then [Pair machines](get-started/pair-machines.md).
- Looking for a command? See [Commands](user-guide/commands.md) or the full [Reference → Commands](reference/commands.md).
- Curious how it works? Read [Architecture](concepts/architecture.md) and [Data flow](concepts/data-flow.md).
- Contributing? Start with [Project layout](developer/project-layout.md) and [Key rules](developer/key-rules.md).
