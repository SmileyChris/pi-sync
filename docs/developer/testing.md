# Testing

pi-sync uses [vitest](https://vitest.dev/) for pure-logic and network-patch
regression tests in `lib.test.ts`, `ws-patch.test.ts`, and
`reconnect-patch.test.ts`.

```bash
npx vitest run      # single run
npx vitest          # watch mode
```

`lib.test.ts` covers:

| Area | Coverage |
|---|---|
| `normalizeFileKey`, `isPiSyncExtensionKey` | Path safety: reject `..`/null bytes/absolute paths |
| `fileKey`, `getSubdir` | Path mapping, Windows separators |
| `localOnlyHostsForKey`, `isLocalOnlyByMap`, `isLocalOnly` | Local-only filtering, prefix/longest-match resolution |
| `shouldSync` | Config toggle gating, pi-sync self-exclusion |
| `mergeSettingsIntoDoc`, `applyJsonMergeInPlace`, `applyJsonAdditionsInPlace` | Normal and first-join JSON merge semantics |
| `unwrapContent`, `syncedFileContentMatches` | Content extraction (ImmutableString-safe) |
| `isTombstone`, `isPastTTL` | Soft-delete lifecycle, 14-day TTL |
| `loadConfig` | Config parsing, corrupt JSON fallback |
| `parsePeer`, `peerHost` | Peer string parsing, host extraction |
| `dirtyKeysFromPatches` | Patch → fileKey mapping, unsafe-key rejection |
| `collectExtensionFiles/SkillFiles/PromptFiles` | Directory walking, skip rules |
| Session key helpers | Native-path filtering, hostname namespacing, incoming-key safety |
| `isDocEmpty` | First-sync protection (don't wipe local files if the doc is empty) |
| `partitionPendingChanges` | Watcher present/deletion routing, mass-delete brake, tombstone idempotence |

When adding new logic, prefer to put it in `lib.ts` and add tests there.

## Running the docs locally

```bash
zensical serve      # live-reload dev server
zensical build      # one-shot build into ./site/
```

`./site/` is gitignored.
