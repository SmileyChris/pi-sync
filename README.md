# pi-sync

Keep your pi coding agent setup in sync across your own machines.

`pi-sync` is a local-first, peer-to-peer sync extension for pi. It shares the
parts of your setup that are useful to keep consistent, such as settings,
models, prompts, skills, and extensions, while leaving machine-specific files
like auth, sessions, caches, and peer config alone.

It uses Automerge CRDTs over WebSocket, so peers can edit independently and
merge when they reconnect. The usual setup is to run it across machines on the
same Tailscale tailnet, with no central server required.

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
