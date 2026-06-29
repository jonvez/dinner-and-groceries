# ADR 0008 — Realtime socket authentication: expose the short-lived access token to the browser

- **Status:** Accepted
- **Date:** 2026-06-29
- **Decided by:** Developer (issue #44 fix), to be confirmed by non-author security review
- **Relates to:** ADR 0003 (RLS-always-in-force; `@supabase/ssr` httpOnly cookie sessions), issue #44, issue #24 (E2E regression home)

## Context

Slice 1b's live collaboration was broken: a subscribed client reached `SUBSCRIBED`
("Live") but received **zero `postgres_changes` events**. Reactions/comments only
appeared after a manual reload.

Root cause (confirmed by live two-client verification):

- The browser client (`lib/supabase/browser.ts`) builds its Realtime websocket via
  `@supabase/ssr` `createBrowserClient(url, anonKey)`. The socket authenticates with
  the **anon key only**.
- Per ADR 0003, session tokens live in **httpOnly cookies**. Client-side JS cannot
  read them, so Realtime never receives the user's JWT.
- The reactions/comments SELECT RLS policy is `household_id = current_household_id()`,
  a `SECURITY DEFINER` helper derived from `auth.uid()`. For an anon socket `auth.uid()`
  is null → the helper returns null → the client is authorized to see **no rows** → no
  events are delivered. The channel still *joins* (that needs only the anon apikey),
  which is why the UI showed "Live". This affected **production**, not just local.

The fix requires the Realtime socket to authenticate **as the signed-in user**. The
standard Supabase pattern is `supabase.realtime.setAuth(accessToken)`, kept fresh on
expiry. But our access token is in an httpOnly cookie, unreadable from JS — so getting
a token to the socket means **deliberately exposing a token to client-side JS**, which
is a security-sensitive change worth recording.

## Decision

Add a small same-origin server route, `GET /auth/realtime-token`, that:

1. Reads the httpOnly cookie session **server-side** (`createServerComponentClient`).
2. Verifies identity with `auth.getUser()` (validated JWT), failing closed (401)
   for any caller without a real session.
3. Returns **only** the **short-lived access token** and its expiry as JSON, with
   `Cache-Control: no-store`.

The browser (`lib/supabase/realtime-auth.ts`, wired into `app/board/proposal-pool.tsx`)
fetches this token, calls `supabase.realtime.setAuth(token)` **before subscribing**,
and re-applies a fresh token on a timer ahead of expiry.

### What is and is NOT exposed

- **Exposed to JS:** the **access token** only — short-lived (≈1h), already the bearer
  every PostgREST request carries, and already RLS-scoped. It grants exactly the
  signed-in user's existing permissions, nothing more.
- **NOT exposed, ever:** the **refresh token** stays in the httpOnly cookie and is
  never read or returned by the route. JS cannot mint new sessions or extend its own
  lifetime; when the access token expires it must re-fetch (which requires the cookie,
  i.e. an authenticated browser).
- **NOT exposed, ever:** the service-role key. RLS remains always-in-force; there is
  no privileged client anywhere near the browser.

## Consequences

**Positive**

- Live `postgres_changes` on `reactions`/`comments` are delivered to already-open
  authenticated clients within ~1–2s, no reload — the capability slice 1b exists to prove.
- The RLS-always-in-force invariant (ADR 0003) is preserved end to end; the socket now
  evaluates RLS as the real user instead of anon.
- The token plumbing is framework-free and unit-tested (`lib/supabase/realtime-auth.test.ts`,
  `app/auth/realtime-token/route-core.test.ts`).

**Negative / residual risk**

- The short-lived access token is now reachable by client-side JS (in memory; never
  cached — `no-store`). This marginally widens the XSS blast radius: script-injection on
  the page could read the current access token. Mitigations: the token is already used as
  a bearer by the app, it is short-lived, the refresh token remains out of reach (so an
  attacker cannot persist access), and the app uses React's default escaping with a
  defense-in-depth URL guard (no `dangerouslySetInnerHTML`). This is the same exposure
  posture as any SPA that holds its access token in memory.
- A new authenticated endpoint exists; it is GET, read-only, returns no state-changing
  capability, and fails closed.

**Alternatives considered**

- *`accessToken` async callback on the client* (`createClient({ accessToken })`): conflicts
  with `@supabase/ssr`'s cookie-based auth for PostgREST; mixing the two is fragile. The
  `setAuth` approach keeps cookie-based PostgREST untouched and scopes the change to Realtime.
- *Stop using httpOnly cookies* (store tokens in JS-readable storage): strictly worse —
  it would expose the **refresh** token to JS. Rejected.

## Follow-ups

- Wire real Realtime delivery into the ephemeral-Supabase E2E (**issue #24**) as the
  permanent regression guard — unit tests mock the channel and cannot catch real delivery,
  which is why #44 shipped.
