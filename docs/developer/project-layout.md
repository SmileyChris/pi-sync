# Project layout

```
extensions/pi-sync/
├── index.ts          # Extension entry point — commands, repo lifecycle, watchers
├── state.ts          # Shared singleton on globalThis (survives jiti reloads)
├── footer.ts         # Custom 2-line TUI footer (sync widget + token stats)
├── lib.ts            # Pure functions & types, testable without Automerge/WASM
├── lib.test.ts       # Unit tests for lib.ts (vitest)
├── ws-patch.test.ts  # WebSocket close regression tests
├── reconnect-patch.test.ts # Reconnect/socket patch regression tests
├── types.ts          # TypeScript interfaces (re-export / documentation)
├── package.json      # Dependencies: @automerge/*, ws, vitest
├── zensical.toml     # Documentation site config
├── docs/             # Documentation site content (this site)
└── README.md         # Slim entry point — install + docs pointer
```

The split between `index.ts` (effectful — Automerge, WS, fs, pi API) and `lib.ts` (pure) is the central architectural rule. See [Key rules](key-rules.md).

`state.ts` exists because pi loads extensions through jiti with `moduleCache: false`, so the module body is re-executed on every `/new` and `/reload`. All mutable runtime state lives on a single object stashed on `globalThis` under `Symbol.for("pi-sync:state")` so every re-instantiation resolves to the same shared instance; without that, fresh `let` bindings would race with the previous instance's still-running timers and listeners.
