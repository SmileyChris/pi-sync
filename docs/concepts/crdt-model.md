# CRDT model

pi-sync uses [Automerge](https://automerge.org/) as its CRDT layer. A single Automerge document holds all synced state for the cluster.

## ImmutableString unwrapping

Automerge may return content fields wrapped as `ImmutableString { val: "..." }` instead of a plain string. All readers of doc content go through `unwrapContent()` in `lib.ts`, which handles both shapes transparently.

Forgetting to unwrap is a frequent source of subtle bugs (`x.startsWith` undefined, `JSON.parse` errors, etc.), so the rule is enforced by convention: any code that reads content fields from the doc must use `unwrapContent()`.

## Per-key settings merge

When importing `settings.json` or `models.json` into the doc, pi-sync uses `applyJsonMergeInPlace()`, which writes individual keys rather than replacing the whole object. `mergeSettingsIntoDoc()` remains as a pure comparison helper for tests and non-proxy callers. Per-key writes preserve Automerge's CRDT semantics, so two peers editing different keys in `settings.json` concurrently will merge cleanly instead of one overwriting the other.

## See also

- [Data flow](data-flow.md) — where these helpers sit in the loop.
- [Project layout](../developer/project-layout.md) — where `lib.ts` lives.
