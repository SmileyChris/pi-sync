/**
 * pi-sync shared state singleton.
 *
 * pi loads extensions through jiti with `moduleCache: false`, so this
 * module is fully re-executed on every `/new` and `/reload`. Module-level
 * `let` bindings are reset on each load, so anything mutable lives on a
 * Symbol-keyed singleton stashed on globalThis. The Symbol.for ensures
 * every re-instantiation resolves to the same shared object.
 */

import type * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type SyncConfig, DEFAULT_SYNC_CONFIG } from "./lib";

// ── Constants ─────────────────────────────────────────────────────────

export const hostname = os.hostname();
export const WATCH_DEBOUNCE_MS = 500;
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REFRESH_ICON_DURATION_MS = 30_000;     // 🔄 visibility window
export const RECENT_REMOTE_CHANGES_CAP = 50;        // ring buffer cap

// ── Shared state ──────────────────────────────────────────────────────

export type SyncState = {
  config: SyncConfig;
  repo: any;
  handle: any;
  wss: any;
  httpServer: http.Server | null;
  watcher: fs.FSWatcher | null;
  /** Debounce timer for batching session file broadcasts. */
  sessionSyncTimer: ReturnType<typeof setTimeout> | null;
  /** Keys of session files that changed since last broadcast. */
  pendingSessionChanges: Set<string>;
  /** Prevent overlapping HTTP session broadcast batches. */
  sessionBroadcastRunning: boolean;
  /** fs.Watcher for session files (non-CRDT sync). */
  sessionWatcher: fs.FSWatcher | null;
  ImmutableString: any;
  wsConnectedPeers: Map<string, { since: number; direction: "in" | "out" }>;
  tcpReachablePeers: Set<string>;
  exporting: boolean;
  suppressExportDepth: number;
  activeUi: ExtensionUIContext | null;
  crashGuardInstalled: boolean;
  initialSyncReady: boolean;
  // True from entry into initRepo (or from probePeer at the bottom of the
  // entry point) until the resulting handle / standby state is observable
  // to the next module load. Closes the race where a `/new` fires inside
  // initRepo's async gap before state.wss / state.handle exist.
  initInProgress: boolean;
  standbyMode: boolean;
  pendingChanges: Set<string>;
  watchTimer: ReturnType<typeof setTimeout> | null;
  renderTimer: ReturnType<typeof setInterval> | null;
  tuiRef: any;
  currentCtx: any;
  purgeInterval: ReturnType<typeof setInterval> | null;
  probeInterval: ReturnType<typeof setInterval> | null;
  lastRemoteChangeTime: number;
  recentRemoteChanges: string[];
  pendingInstalls: Set<string>;
  installRunning: boolean;
  // Snapshot of config.peers taken when initRepo wired up the network
  // adapters. The running Automerge repo binds its peer list at
  // construction; later /sync:peers add|remove edits config.peers and
  // disk, but the live adapter set won't change until /reload. This
  // snapshot lets /sync:status surface "edited since last reload".
  peersAtInit: string[];
  // Cached union of config.peers + doc.knownPeers (hostnames only).
  // Updated at init and whenever the doc's knownPeers changes.
  // Footer and /sync:status read this to show the full mesh roster.
  meshPeerHosts: Set<string>;
};

const STATE_KEY = Symbol.for("pi-sync:state");
type StateHost = typeof globalThis & { [STATE_KEY]?: SyncState };

export const state: SyncState = ((globalThis as StateHost)[STATE_KEY] ??= ({
  config: { ...DEFAULT_SYNC_CONFIG },
  repo: null,
  handle: null,
  wss: null,
  httpServer: null,
  watcher: null,
  sessionSyncTimer: null,
  pendingSessionChanges: new Set(),
  sessionBroadcastRunning: false,
  sessionWatcher: null,
  ImmutableString: null,
  wsConnectedPeers: new Map(),
  tcpReachablePeers: new Set(),
  exporting: false,
  suppressExportDepth: 0,
  activeUi: null,
  crashGuardInstalled: false,
  initialSyncReady: false,
  initInProgress: false,
  standbyMode: false,
  pendingChanges: new Set(),
  watchTimer: null,
  renderTimer: null,
  tuiRef: null,
  currentCtx: null,
  purgeInterval: null,
  probeInterval: null,
  lastRemoteChangeTime: 0,
  recentRemoteChanges: [],
  pendingInstalls: new Set(),
  installRunning: false,
  peersAtInit: [],
  meshPeerHosts: new Set(),
})); // not sealed — allows schema migration across reloads

// The singleton survives jiti reloads, so initialize fields introduced by a
// newer extension version when an older state object is already resident.
state.sessionBroadcastRunning ??= false;
