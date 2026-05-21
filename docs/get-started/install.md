# Install

Install dependencies in the `pi-sync` extension directory:

```bash
cd ~/.pi/agent/extensions/pi-sync
npm install
```

Once installed, configure peers (see [Pair machines](pair-machines.md)) and reload pi.

The `pi-sync` extension is local to each machine — it is **never** synced through itself, so you must install it manually on every peer.
