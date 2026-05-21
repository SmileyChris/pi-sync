# Testing

pi-sync uses [vitest](https://vitest.dev/) for unit tests. All tests live in `lib.test.ts`.

```bash
npx vitest run      # single run
npx vitest          # watch mode
```

At the time of writing there are **105 tests** in `lib.test.ts` covering:

| Area | Coverage |
|---|---|
| `normalizeFileKey`, `isPiSyncExtensionKey` | Path safety: reject `..`/null bytes/absolute paths |
| `fileKey`, `getSubdir` | Path mapping, Windows separators |
| `isLocalOnlyByMap`, `isLocalOnly` | Local-only filtering, prefix/longest-match resolution |
| `shouldSync` | Config toggle gating, pi-sync self-exclusion |
| `mergeSettingsIntoDoc` | JSON merge, key removal, immutability |
| `unwrapContent`, `syncedFileContentMatches` | Content extraction (ImmutableString-safe) |
| `isTombstone`, `isPastTTL` | Soft-delete lifecycle, 14-day TTL |
| `loadConfig` | Config parsing, corrupt JSON fallback |
| `parsePeer`, `peerHost` | Peer string parsing, host extraction |
| `dirtyKeysFromPatches` | Patch → fileKey mapping, unsafe-key rejection |
| `collectExtensionFiles/SkillFiles/PromptFiles` | Directory walking, skip rules |

When adding new logic, prefer to put it in `lib.ts` and add tests there.

## Running the docs locally

```bash
zensical serve      # live-reload dev server
zensical build      # one-shot build into ./site/
```

`./site/` is gitignored.
