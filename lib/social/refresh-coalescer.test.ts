import { describe, expect, it, vi } from "vitest";

import { createServerRefreshCoalescer } from "./refresh-coalescer";

/**
 * The board's "a row changed → ask the SERVER to re-render" trigger (issue #64,
 * ADR 0013 §2). Pure logic with injected timers, so the refresh-storm guard is
 * exhaustively tested away from React and the socket.
 */

function harness(settleAfterMs = 2_000) {
  const refresh = vi.fn();
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const coalescer = createServerRefreshCoalescer({
    refresh,
    settleAfterMs,
    schedule: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length - 1;
    },
    cancel: (handle) => {
      const timer = timers[handle as number];
      if (timer) timer.cancelled = true;
    },
  });
  /** Fire every not-yet-cancelled timer (the safety window elapsing). */
  const elapse = () => {
    for (const timer of timers) {
      if (timer.cancelled) continue;
      timer.cancelled = true;
      timer.fn();
    }
  };
  return { coalescer, refresh, timers, elapse };
}

describe("createServerRefreshCoalescer", () => {
  it("refreshes immediately on the first request", () => {
    const { coalescer, refresh } = harness();
    coalescer.request();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into ONE refresh in flight (no refresh storm)", () => {
    // Several proposals can land in the same breath; each refresh is a full
    // server round trip, so only one may be outstanding at a time.
    const { coalescer, refresh } = harness();
    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one follow-up when the snapshot lands after a coalesced burst", () => {
    // The changes that arrived WHILE the refresh was in flight may not be in
    // the snapshot it returns (the server may have read the DB before they
    // committed), so they are owed one more round trip — one, not one each.
    const { coalescer, refresh } = harness();
    coalescer.request();
    coalescer.request();
    coalescer.request();
    coalescer.settled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not follow up when nothing arrived while the refresh was in flight", () => {
    const { coalescer, refresh } = harness();
    coalescer.request();
    coalescer.settled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately again once the previous one has settled", () => {
    const { coalescer, refresh } = harness();
    coalescer.request();
    coalescer.settled();
    coalescer.request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels the safety timer when the snapshot lands, so there is no double follow-up", () => {
    const { coalescer, refresh, elapse } = harness();
    coalescer.request();
    coalescer.request(); // queues a follow-up
    coalescer.settled(); // -> the one follow-up
    expect(refresh).toHaveBeenCalledTimes(2);
    elapse(); // the first request's safety window must be dead
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("un-sticks itself if the snapshot never lands (safety window)", () => {
    // A refresh whose snapshot is byte-identical produces no new props, so
    // `settled()` may never be called. The in-flight flag must not latch
    // forever, or the board would stop reacting to later changes.
    const { coalescer, refresh, timers, elapse } = harness(2_000);
    coalescer.request();
    expect(timers[0].ms).toBe(2_000);
    elapse();
    coalescer.request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pays a queued follow-up when the safety window elapses", () => {
    const { coalescer, refresh, elapse } = harness();
    coalescer.request();
    coalescer.request();
    elapse();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores a settle when no refresh is in flight", () => {
    const { coalescer, refresh } = harness();
    coalescer.settled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops refreshing after stop() and cancels the pending safety timer", () => {
    // Teardown (unmount): a refresh on a gone component is pointless, and a
    // live timer would leak.
    const { coalescer, refresh, timers, elapse } = harness();
    coalescer.request();
    coalescer.request();
    coalescer.stop();
    expect(timers[0].cancelled).toBe(true);
    elapse();
    coalescer.request();
    coalescer.settled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
