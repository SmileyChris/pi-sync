# Project layout

```
extensions/pi-sync/
├── index.ts          # Extension entry point — commands, repo lifecycle, watchers
├── lib.ts            # Pure functions & types, testable without Automerge/WASM
├── lib.test.ts       # Unit tests for lib.ts (vitest)
├── types.ts          # TypeScript interfaces (re-export / documentation)
├── package.json      # Dependencies: @automerge/*, ws, vitest
├── zensical.toml     # Documentation site config
├── docs/             # Documentation site content (this site)
└── README.md         # Slim entry point — install + docs pointer
```

The split between `index.ts` (effectful — Automerge, WS, fs, pi API) and `lib.ts` (pure) is the central architectural rule. See [Key rules](key-rules.md).
