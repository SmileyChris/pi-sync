# pi-sync

P2P sync for pi coding agent settings using Automerge CRDTs over WebSocket.

## Install

```bash
cd ~/.pi/agent/extensions/pi-sync
npm install
```

## Quick start

On the **first machine** (creator), run `/sync:info` and copy the `automerge:…` URL.

On a **second machine** (joiner):

```
/sync:peers add <first-machine-hostname>:3030
/sync:import <automerge-url>
/reload
```

Both machines must be reachable over your network (typically a Tailscale tailnet). See [Pair machines](docs/get-started/pair-machines.md) for the full guide.

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
