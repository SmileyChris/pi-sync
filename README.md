# pi-sync

Keep your pi coding agent setup in sync across your own machines.

`pi-sync` is a local-first, peer-to-peer sync extension for pi. It shares the
parts of your setup that are useful to keep consistent, such as settings,
models, prompts, skills, extensions, and session history, while leaving
machine-specific files like auth, caches, and peer config alone.

It uses Automerge CRDTs over WebSocket in a full-mesh topology — every peer
connects to every other. Peers can edit independently and merge when they
reconnect. No central server, no primary node. Typically run across machines
on the same Tailscale tailnet.

### What syncs

| Category    | Path                                  |
|------------|---------------------------------------|
| settings   | `~/.pi/agent/settings.json`           |
| models     | `~/.pi/agent/models.json`             |
| extensions | `~/.pi/agent/extensions/`             |
| skills     | `~/.pi/agent/skills/`                 |
| prompts    | `~/.pi/agent/prompts/`                |
| sessions   | `~/.pi/agent/sessions/` (`.jsonl` only) |

Session files are keyed by source hostname so remote sessions land under
`sessions/{hostname}/` on every peer — clearly distinguishable from local
sessions and automatically indexed by pi-session-search.

## Install

Install `pi-sync` on every machine you want to sync. The extension deliberately
does not sync itself.

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/SmileyChris/pi-sync.git ~/.pi/agent/extensions/pi-sync
cd ~/.pi/agent/extensions/pi-sync
npm install
```

## Quick start

On the **first machine** (creator), run `/sync:info` and copy the
`automerge:...` URL.

On a **second machine** (joiner):

```
/sync:peers add <first-machine-hostname>:3030
/sync:import <automerge-url>
/reload
```

Both machines must be reachable over your network, typically a Tailscale
tailnet. See [Pair machines](docs/get-started/pair-machines.md) for the full
guide.

## Docs

Full documentation lives under `docs/`. To read it as a site:

```bash
zensical serve
```

Or browse the source markdown directly:

- Get Started — [`docs/get-started/`](docs/get-started/)
- User Guide — [`docs/user-guide/`](docs/user-guide/)
- Concepts — [`docs/concepts/`](docs/concepts/)
- Developer — [`docs/developer/`](docs/developer/)
- Reference — [`docs/reference/`](docs/reference/)

## Tests

```bash
npx vitest run
```
