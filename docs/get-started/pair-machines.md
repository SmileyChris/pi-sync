# Pair machines

Pairing brings a second (or third, fourth, …) machine into an existing sync network.

## 1. Configure peers

Edit `~/.config/pi-sync/config.json`:

```json
{
  "port": 3030,
  "peers": [
    "laptop.tailnet.ts.net:3030",
    "desktop.tailnet.ts.net:3030"
  ]
}
```

Or use in-app commands (see [Commands](../user-guide/commands.md)).

## 2. First machine (creator)

On the machine that already has content:

```
/sync:info
```

Copy the `automerge:…` URL it prints.

## 3. Second machine (joiner)

On the new machine:

```
/sync:peers add <first-machine-hostname>:3030
/sync:import <automerge-url>
/reload
```

After reload, established cluster values win conflicts and appear on the second
machine. Files and JSON keys unique to the joiner are contributed to the
cluster. Changes then propagate both ways automatically.

## See also

- [Configuration](../user-guide/config.md) — toggle which categories sync.
- [Local-only files](../user-guide/local-only.md) — keep sensitive paths off the network.
