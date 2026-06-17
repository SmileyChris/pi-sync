# Config schema

`~/.config/pi-sync/config.json`.

## `port`

- **Type:** integer
- **Default:** `3030`
- **Description:** WebSocket port to listen on for inbound peer connections.

## `peers`

- **Type:** array of strings, each `"host:port"`
- **Default:** `[]`
- **Description:** Other machines to dial outbound. Use Tailscale `MagicDNS` names (e.g., `laptop.tailnet.ts.net:3030`).

## `syncSettings`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/settings.json` (per-key merge).

## `syncModels`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/models.json` (per-key merge).

## `syncExtensions`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/extensions/*` code + assets. The `pi-sync` extension is always excluded regardless of this flag.

## `syncSkills`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/skills/**/*.md`.

## `syncPrompts`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/prompts/**/*.md` and `**/*.txt`.

## `syncSessions`

- **Type:** boolean
- **Default:** `true`
- **Description:** Sync `~/.pi/agent/sessions/**/*.jsonl` (session history).
Files are keyed by source hostname so remote sessions land under
`sessions/{hostname}/` — clearly distinguishable from local sessions
and automatically indexed by pi-session-search.

## Other files in `~/.config/pi-sync/`

| File | Purpose |
|---|---|
| `doc-url` | Automerge document URL (join key). Written on `/sync:import` or first-machine doc creation. |
