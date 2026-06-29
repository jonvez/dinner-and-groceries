/**
 * Realtime socket authentication plumbing (issue #44).
 *
 * THE BUG: the browser `@supabase/ssr` client builds its Realtime websocket
 * with the **anon key only**. Our session tokens live in httpOnly cookies, so
 * client-side JS cannot read them and the socket never receives the user's JWT.
 * RLS-gated `postgres_changes` on `reactions`/`comments` then evaluate as anon
 * (`auth.uid()` is null → the `current_household_id()` SECURITY DEFINER helper
 * returns null → the client is authorized to see NO rows), so Realtime delivers
 * zero events even though the channel still JOINs (it only needs the apikey).
 * That is why the UI showed "Live" while nothing ever arrived.
 *
 * THE FIX: fetch the **short-lived access token** from a small same-origin
 * server route (which reads the httpOnly cookie server-side — the refresh token
 * never leaves the server) and hand it to `realtime.setAuth(token)` BEFORE
 * subscribing, then keep it fresh on a timer ahead of expiry. This keeps the
 * RLS-always-in-force model intact: no service-role key in the browser, and the
 * refresh token stays httpOnly. See ADR 0008.
 *
 * This module is framework-free (pure logic + injectable deps) so it can be
 * unit-tested away from React and the network — the integration gap that let
 * this ship (the component test mocks the channel) is exactly why the logic
 * lives here.
 */

export type RealtimeTokenResponse = {
  /** The signed-in user's short-lived access JWT (never the refresh token). */
  token: string;
  /** Unix epoch SECONDS at which the access token expires, or null if unknown. */
  expiresAt: number | null;
};

const TOKEN_ENDPOINT = "/auth/realtime-token";

/** Refresh this far ahead of expiry so a renewal lands before the old token dies. */
const DEFAULT_SKEW_MS = 60_000;
/** Never schedule a refresh sooner than this (avoids a hot loop near expiry). */
const DEFAULT_MIN_MS = 5_000;
/** Re-check interval when the server didn't tell us when the token expires. */
const DEFAULT_FALLBACK_MS = 10 * 60_000;

/**
 * Fetch the current access token from the server route. Returns null (never
 * throws) for any failure — signed-out, network error, or a malformed body —
 * so callers can degrade gracefully (the board is still correct without
 * Realtime; live updates simply stay paused).
 */
export async function fetchRealtimeToken(
  opts: { fetchFn?: typeof fetch; url?: string } = {},
): Promise<RealtimeTokenResponse | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = opts.url ?? TOKEN_ENDPOINT;
  try {
    const res = await fetchFn(url, {
      // Same-origin so the httpOnly session cookie is sent; never cache a token.
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const token = body.token;
    if (typeof token !== "string" || token === "") return null;
    const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Compute how long (ms) to wait before refreshing, given the token's expiry
 * (unix seconds) and the current time (ms). Refresh a skew BEFORE expiry,
 * clamped to a sane minimum; fall back to a fixed interval if expiry is unknown.
 */
export function nextRefreshDelayMs(
  expiresAtSec: number | null,
  nowMs: number,
  opts: { skewMs?: number; minMs?: number; fallbackMs?: number } = {},
): number {
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const minMs = opts.minMs ?? DEFAULT_MIN_MS;
  const fallbackMs = opts.fallbackMs ?? DEFAULT_FALLBACK_MS;
  if (expiresAtSec == null) return fallbackMs;
  const delay = expiresAtSec * 1000 - nowMs - skewMs;
  return Math.max(minMs, delay);
}

export type RealtimeAuthenticatorDeps = {
  /** Apply a token to the Realtime socket (e.g. `supabase.realtime.setAuth`). */
  setAuth: (token: string) => void | Promise<void>;
  /** Fetch the current token (defaults to `fetchRealtimeToken`). */
  getToken: () => Promise<RealtimeTokenResponse | null>;
  /** Schedule a one-shot timer (defaults to setTimeout); injectable for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancel a scheduled timer (defaults to clearTimeout). */
  cancel?: (handle: unknown) => void;
  /** Current time in ms (defaults to Date.now); injectable for tests. */
  now?: () => number;
  refreshSkewMs?: number;
};

export type RealtimeAuthenticator = {
  /** Fetch + apply the token, then schedule refresh. Resolves once the socket is authenticated. */
  start: () => Promise<void>;
  /** Cancel any pending refresh and suppress in-flight auth (call on teardown). */
  stop: () => void;
};

/**
 * Keep a Realtime socket authenticated as the signed-in user: apply the current
 * token now, then re-apply just before it expires. `start()` resolves once the
 * first token is applied so callers can subscribe with an authenticated socket.
 */
export function createRealtimeAuthenticator(
  deps: RealtimeAuthenticatorDeps,
): RealtimeAuthenticator {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  let stopped = false;
  let timer: unknown = null;

  async function refresh(): Promise<void> {
    const result = await deps.getToken();
    // The component may have unmounted (or the user signed out) mid-fetch — do
    // not authenticate a torn-down socket, and do not schedule further work.
    if (stopped || !result) return;
    await deps.setAuth(result.token);
    if (stopped) return;
    const delay = nextRefreshDelayMs(result.expiresAt, now(), {
      skewMs: deps.refreshSkewMs,
    });
    timer = schedule(() => {
      void refresh();
    }, delay);
  }

  return {
    start: refresh,
    stop() {
      stopped = true;
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
