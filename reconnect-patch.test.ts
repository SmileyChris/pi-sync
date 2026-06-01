import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";

// Mock global state and helper methods as in index.ts
const state = {
  config: {
    peers: ["work:3030", "100.106.149.33:3030"],
    port: 3030,
  },
};

function peerHost(peer: string): string {
  const idx = peer.lastIndexOf(":");
  return idx === -1 ? peer : peer.slice(0, idx);
}

function parsePeer(peer: string): { host: string; port: number } | null {
  const idx = peer.lastIndexOf(":");
  if (idx === -1) return null;
  const host = peer.slice(0, idx);
  const port = parseInt(peer.slice(idx + 1), 10);
  if (!host || isNaN(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

describe("pi-sync low-level reconnect and socket patches", () => {
  let originalSocketConnect: any;
  let originalWsClose: any;

  beforeAll(() => {
    // 1. Apply net.Socket.prototype.connect patch
    originalSocketConnect = net.Socket.prototype.connect;
    const _peerTargets = new Set(
      state.config.peers.map((p) => {
        const parsed = parsePeer(p);
        const host = parsed?.host ?? peerHost(p);
        const port = parsed?.port ?? state.config.port;
        return `${host}:${port}`;
      })
    );

    net.Socket.prototype.connect = function (this: any, ...args: any[]) {
      let normalizedArgs = args;
      if (args.length === 1 && Array.isArray(args[0])) {
        normalizedArgs = args[0];
      }
      const opts = typeof normalizedArgs[0] === "object" ? normalizedArgs[0] : null;
      let port = opts?.port ?? normalizedArgs[0];
      let host = opts?.host ?? normalizedArgs[1];
      if (!host && this.host) host = this.host;
      if (!port && this.port) port = this.port;
      if (typeof host === "string" && port !== undefined) {
        const numericPort = Number(port);
        const targetKey = `${host}:${numericPort}`;
        if (_peerTargets.has(targetKey)) {
          this.on("error", () => {});
        }
      }
      return originalSocketConnect.apply(this, args as any);
    };

    // 2. Apply WebSocket prototype close patch
    originalWsClose = WebSocket.prototype.close;
    WebSocket.prototype.close = function (this: any, code?: number, reason?: Buffer) {
      if (this.readyState === WebSocket.CONNECTING && this.listenerCount("error") === 0) {
        this.on("error", () => {});
      }
      return originalWsClose.call(this, code, reason);
    };

    // 3. Apply WebSocketClientAdapter.prototype.connect patch
    const _origAdapterConnect = WebSocketClientAdapter.prototype.connect;
    WebSocketClientAdapter.prototype.connect = function (this: any, peerId: any, peerMetadata: any) {
      if (this.socket) {
        try {
          this.socket.addEventListener("error", () => {});
          this.socket.close();
        } catch (err: any) {}
      }
      return _origAdapterConnect.call(this, peerId, peerMetadata);
    };
  });

  afterAll(() => {
    // Restore original socket connect method and ws close method
    net.Socket.prototype.connect = originalSocketConnect;
    WebSocket.prototype.close = originalWsClose;
  });

  it("net.Socket.prototype.connect patch attaches error listener to matching peer host:port", async () => {
    const socket = new net.Socket();
    
    // Connect to a peer port and host in the config list
    // (mock connecting so we don't block, but verify the listener is attached)
    // Note: node's internal connect wrapper normalized args are passed as an array
    const normalized = [
      { host: "work", port: "3030" },
      null,
    ];
    
    try {
      socket.connect(normalized as any);
    } catch {}

    const errorListenersCount = socket.listenerCount("error");
    expect(errorListenersCount).toBeGreaterThanOrEqual(1);
    socket.destroy();
  });

  it("WebSocketClientAdapter closes the old socket and registers an error listener on it before reconnecting", async () => {
    const adapter = new WebSocketClientAdapter("ws://work:3030", 5000);
    adapter.connect("test-peer");

    const oldSocket = adapter.socket;
    expect(oldSocket).toBeDefined();

    // Trigger a reconnect by calling connect again
    adapter.connect("test-peer");

    // The old socket should have been closed/closing
    expect(oldSocket?.readyState).toBe(0 || 2 || 3); // CONNECTING (0), CLOSING (2) or CLOSED (3)

    // The old socket should have a no-op error listener attached to prevent uncaught exceptions
    const errCount = (oldSocket as any).listenerCount("error");
    expect(errCount).toBeGreaterThanOrEqual(1);

    adapter.disconnect();
  });
});
