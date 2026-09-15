/**
 * Coalesce "ask the SERVER to re-render" triggers into at most one round trip
 * in flight (issue #64, ADR 0013 §2).
 *
 * WHY THIS EXISTS. A `proposals` Realtime payload carries the table's own
 * columns only — no dish title, no proposer name, both of which come from
 * server-side joins (app/board/page.tsx). So a proposal change is a TRIGGER,
 * not something to render: we call `router.refresh()` and let the server
 * re-render the authoritative, RLS-scoped, fully-joined snapshot. (A
 * browser-client read is prohibited: auth cookies are httpOnly (ADR 0008), so
 * it would run as anon, RLS would deny it, and the board would blank — #114.)
 *
 * That makes each trigger a full server round trip, and triggers arrive in
 * bursts: a member posting two ideas in a row, or a reconnect. Firing one
 * refresh per event is a refresh storm. So:
 *
 *   - `request()` refreshes immediately if nothing is in flight, otherwise it
 *     just remembers that more changed.
 *   - `settled()` is called when a fresh server snapshot actually lands. If
 *     anything arrived while the refresh was in flight, it is owed exactly ONE
 *     follow-up (that snapshot may have been read before those rows committed),
 *     not one per event.
 *   - a safety window bounds the in-flight state. A refresh whose snapshot is
 *     byte-identical produces no new props, so `settled()` might never be
 *     called; without the window the in-flight flag would latch and the board
 *     would stop responding to later changes.
 *
 * Framework-free with injectable timers, so the storm guard is unit-tested away
 * from React and the socket — the same reason lib/supabase/realtime-auth.ts is
 * shaped this way (a mocked channel is what let #63 ship).
 */

/** How long a refresh may be considered "in flight" before we give up waiting. */
const DEFAULT_SETTLE_AFTER_MS = 2_000;

export type ServerRefreshCoalescerDeps = {
  /** Trigger the server re-render (e.g. `router.refresh()`). */
  refresh: () => void;
  /** Schedule a one-shot timer (defaults to setTimeout); injectable for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancel a scheduled timer (defaults to clearTimeout). */
  cancel?: (handle: unknown) => void;
  /** Safety window before an unacknowledged refresh is treated as settled. */
  settleAfterMs?: number;
};

export type ServerRefreshCoalescer = {
  /** Something changed: refresh now, or note it for the one follow-up. */
  request: () => void;
  /** A fresh server snapshot landed — pay any coalesced follow-up. */
  settled: () => void;
  /** Teardown: cancel the safety timer and refresh no more. */
  stop: () => void;
};

export function createServerRefreshCoalescer(
  deps: ServerRefreshCoalescerDeps,
): ServerRefreshCoalescer {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const settleAfterMs = deps.settleAfterMs ?? DEFAULT_SETTLE_AFTER_MS;

  let stopped = false;
  let inFlight = false;
  let queued = false;
  let timer: unknown = null;

  function clearTimer() {
    if (timer != null) cancel(timer);
    timer = null;
  }

  function fire() {
    queued = false;
    inFlight = true;
    clearTimer();
    timer = schedule(settled, settleAfterMs);
    deps.refresh();
  }

  function settled() {
    if (stopped) return;
    clearTimer();
    if (!inFlight) return;
    inFlight = false;
    // Exactly one follow-up for everything that arrived while in flight.
    if (queued) fire();
  }

  return {
    request() {
      if (stopped) return;
      if (inFlight) {
        queued = true;
        return;
      }
      fire();
    },
    settled,
    stop() {
      stopped = true;
      queued = false;
      inFlight = false;
      clearTimer();
    },
  };
}
