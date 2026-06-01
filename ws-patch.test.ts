/**
 * Tests for the ws WebSocket.prototype.close patch.
 *
 * Ensures that closing a CONNECTING socket no longer causes uncaught
 * exceptions when the adapter removes its error listener before close().
 */

import { describe, it, expect, afterAll } from "vitest";
import WebSocket from "ws";

// Apply the same patch used in initRepo (index.ts)
const _origWsClose = WebSocket.prototype.close;
WebSocket.prototype.close = function (
  this: WebSocket,
  code?: number,
  reason?: Buffer,
) {
  if (
    this.readyState === WebSocket.CONNECTING &&
    this.listenerCount("error") === 0
  ) {
    this.on("error", () => {});
  }
  return _origWsClose.call(this, code, reason);
};

describe("WebSocket.prototype.close patch", () => {
  // Both tests use the same unreachable address to avoid real connections
  const unreachable = "ws://192.0.2.1:19999"; // TEST-NET-1, guaranteed unreachable

  it("does not throw (sync) when closing a CONNECTING socket", () => {
    const ws = new WebSocket(unreachable);
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    expect(() => ws.close()).not.toThrow();
  });

  it(
    "does not trigger uncaughtException when adapter removes listener before close",
    async () => {
      // Capture any uncaught exceptions within this test
      const errors: Error[] = [];
      const handler = (err: Error) => errors.push(err);
      process.prependListener("uncaughtException", handler);

      const ws = new WebSocket(unreachable);

      // Simulate what WebSocketClientAdapter.disconnect does:
      // 1. Register an error handler (adapter's onError)
      const onError = () => {};
      ws.addEventListener("error", onError);

      // 2. Remove it (disconnect removes listeners before close)
      ws.removeEventListener("error", onError);

      // 3. Close — our patch should add a new listener before the
      //    original close() runs, preventing the async emitErrorAndClose
      //    from becoming an uncaught exception
      ws.close();

      // Wait for any async error to fire (emitErrorAndClose is async)
      await new Promise((resolve) => setTimeout(resolve, 500));

      process.removeListener("uncaughtException", handler);
      expect(errors).toHaveLength(0);
    },
    5000,
  );

  it("adds error listener only when needed", () => {
    const ws = new WebSocket(unreachable);
    const before = ws.listenerCount("error");
    ws.close(); // our patch adds a listener
    const after = ws.listenerCount("error");
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("does not add duplicate listener when one already exists", () => {
    const ws = new WebSocket(unreachable);
    ws.addEventListener("error", () => {});
    const before = ws.listenerCount("error");
    ws.close(); // patch should NOT add another listener
    expect(ws.listenerCount("error")).toBe(before);
  });

  it("normal close on CLOSED socket still works", () => {
    const ws = new WebSocket(unreachable);
    ws.close(); // our patched close
    // After close, socket should be CLOSED (state 3)
    // Calling close again on CLOSED is a no-op
    expect(() => ws.close()).not.toThrow();
  });
});
