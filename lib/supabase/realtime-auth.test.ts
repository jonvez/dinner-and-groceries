import { describe, expect, it, vi } from "vitest";

import {
  createRealtimeAuthenticator,
  fetchRealtimeToken,
  nextRefreshDelayMs,
} from "./realtime-auth";

/**
 * Unit tests for the Realtime token plumbing (issue #44).
 *
 * The bug: the browser Realtime socket authenticated with the anon key only,
 * so RLS-gated postgres_changes on reactions/comments delivered NO events.
 * These framework-free tests cover the logic that fetches the short-lived
 * access token from the server route and keeps the socket's auth fresh.
 */

describe("fetchRealtimeToken", () => {
  it("returns the token + expiry on a 200 response", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { token: "jwt-123", expiresAt: 1_900_000_000 }),
    );
    const result = await fetchRealtimeToken({ fetchFn });
    expect(result).toEqual({ token: "jwt-123", expiresAt: 1_900_000_000 });
  });

  it("requests the token endpoint with credentials and no caching (token is sensitive)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { token: "jwt-123", expiresAt: null }),
    );
    await fetchRealtimeToken({ fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      "/auth/realtime-token",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("returns null on a non-ok response (e.g. signed-out 401)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: "unauthenticated" }));
    expect(await fetchRealtimeToken({ fetchFn })).toBeNull();
  });

  it("returns null when the body has no usable token", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { token: "" }));
    expect(await fetchRealtimeToken({ fetchFn })).toBeNull();
  });

  it("returns null (never throws) when the fetch itself rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await fetchRealtimeToken({ fetchFn })).toBeNull();
  });

  it("tolerates a missing/invalid expiresAt by returning null expiry", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { token: "jwt-123" }));
    expect(await fetchRealtimeToken({ fetchFn })).toEqual({
      token: "jwt-123",
      expiresAt: null,
    });
  });
});

describe("nextRefreshDelayMs", () => {
  it("refreshes a safety skew BEFORE the token expires", () => {
    const now = 1_000_000_000_000; // ms
    const expiresAtSec = now / 1000 + 3600; // +1h
    const delay = nextRefreshDelayMs(expiresAtSec, now, { skewMs: 60_000 });
    expect(delay).toBe(3600_000 - 60_000);
  });

  it("clamps to the minimum when the token is already near/at expiry", () => {
    const now = 1_000_000_000_000;
    const expiresAtSec = now / 1000 + 1; // basically expired vs. the skew
    const delay = nextRefreshDelayMs(expiresAtSec, now, {
      skewMs: 60_000,
      minMs: 5_000,
    });
    expect(delay).toBe(5_000);
  });

  it("uses a fallback interval when expiry is unknown", () => {
    const delay = nextRefreshDelayMs(null, 1_000_000_000_000, {
      fallbackMs: 600_000,
    });
    expect(delay).toBe(600_000);
  });
});

describe("createRealtimeAuthenticator", () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const setAuth = vi.fn(async () => {});
    const getToken = vi.fn(async () => ({ token: "jwt-1", expiresAt: null }));
    const scheduled: { fn: () => void; ms: number }[] = [];
    const schedule = vi.fn((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length; // a fake handle
    });
    const cancel = vi.fn();
    return {
      setAuth,
      getToken,
      schedule,
      cancel,
      now: () => 0,
      scheduled,
      ...overrides,
    };
  }

  it("authenticates the socket with the fetched token on start()", async () => {
    const d = deps();
    const auth = createRealtimeAuthenticator(d);
    await auth.start();
    expect(d.getToken).toHaveBeenCalledTimes(1);
    expect(d.setAuth).toHaveBeenCalledWith("jwt-1");
  });

  it("schedules a refresh based on the token's expiry", async () => {
    const expiresAtSec = 3600; // now() is 0 => +1h
    const d = deps({
      getToken: vi.fn(async () => ({ token: "jwt-1", expiresAt: expiresAtSec })),
    });
    const auth = createRealtimeAuthenticator(d);
    await auth.start();
    expect(d.schedule).toHaveBeenCalledTimes(1);
    // skew default 60s before the +1h expiry
    expect(d.scheduled[0].ms).toBe(3600_000 - 60_000);
  });

  it("re-fetches and re-applies the token when the scheduled refresh fires", async () => {
    const d = deps();
    const auth = createRealtimeAuthenticator(d);
    await auth.start();
    d.setAuth.mockClear();
    d.getToken.mockClear();
    // Fire the scheduled refresh.
    await d.scheduled[0].fn();
    expect(d.getToken).toHaveBeenCalledTimes(1);
    expect(d.setAuth).toHaveBeenCalledWith("jwt-1");
  });

  it("does not call setAuth and does not schedule when no token is available", async () => {
    const d = deps({ getToken: vi.fn(async () => null) });
    const auth = createRealtimeAuthenticator(d);
    await auth.start();
    expect(d.setAuth).not.toHaveBeenCalled();
    expect(d.schedule).not.toHaveBeenCalled();
  });

  it("stop() cancels the pending refresh and suppresses a late setAuth", async () => {
    let resolveToken!: (v: { token: string; expiresAt: number | null }) => void;
    const getToken = vi.fn(
      () =>
        new Promise<{ token: string; expiresAt: number | null }>((r) => {
          resolveToken = r;
        }),
    );
    const d = deps({ getToken });
    const auth = createRealtimeAuthenticator(d);
    const started = auth.start();
    auth.stop();
    // The in-flight fetch resolves AFTER stop — must not authenticate a torn-down socket.
    resolveToken({ token: "late", expiresAt: null });
    await started;
    expect(d.setAuth).not.toHaveBeenCalled();
  });

  it("stop() cancels an already-scheduled refresh handle", async () => {
    const d = deps({
      getToken: vi.fn(async () => ({ token: "jwt-1", expiresAt: 3600 })),
    });
    const auth = createRealtimeAuthenticator(d);
    await auth.start();
    auth.stop();
    expect(d.cancel).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
