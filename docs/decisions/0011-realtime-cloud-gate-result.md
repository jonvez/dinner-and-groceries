# ADR 0011 — P4 gate result: Realtime verified against cloud Supabase (conditional PASS)

- **Status:** Accepted
- **Date:** 2026-07-21
- **Decided by:** Jon + agent (two-client live check), per the #54 gate protocol
- **Relates to:** #54 (P4 — the gate this ADR records), #46 (parent production slice),
  ADR 0008 (Realtime socket auth / token-exposure), #44 (the socket-auth fix being
  re-verified), ADR 0009 (deployment topology), ADR 0010 (cloud-Supabase-as-prod).
  **Findings filed:** #63 (bug), #64 (enhancement).

## Context

#54 is the highest-risk item in the production slice: ADR 0008 / #44 fixed live
`postgres_changes` delivery by authenticating the Realtime socket **as the signed-in
user** (`realtime.setAuth` with a short-lived access token minted server-side). That fix
was validated **locally**. Hosted Supabase can behave differently on Realtime (JWT/JWKS,
publication config, Free-tier authorization behaviour), so #54 required **re-verifying the
behaviour against the cloud project before production is trusted** — explicitly: *do not
assume local-green ⇒ cloud-green*.

The cloud project is **Free tier** (`wcbjuobzeursmomcoefw`). This ADR records the gate
methodology, the result, and the two defects the gate surfaced.

## Methodology

A live two-client check against the deployed app (`…run.app`) on cloud Supabase:

- **Watcher** — a browser signed in as the owner, board left open, never touched;
  instrumented via the browser's network/console so socket behaviour could be inspected,
  not just the rendered UI.
- **Actor** — a second household member (a real second Google account, "Jojo") on a
  separate device, performing reactions/comments.

Two classes of evidence were gathered:

1. **Behavioural delivery** — actor acts, watcher's already-open board updates live with no
   reload (DOM read directly, not a reload).
2. **Socket-level authorization** — the Realtime-token JWT was decoded live, and a
   purpose-built probe opened **two raw Realtime sockets subscribed to _all_ reactions with
   the household filter removed**: one authenticated as the user, one an **anon join** (public
   key only, no user token). With the client filter removed, **RLS is the only thing that can
   gate delivery**, so the anon-vs-authenticated contrast isolates socket-level RLS from the
   client-side convenience filter. The authenticated socket served as the positive control.

## Result — conditional PASS

| Property (against **cloud** Supabase) | Result |
|---|---|
| Reaction **INSERT** delivery to a second client | ✅ PASS — live, no reload, <1s observed |
| Comment **INSERT** delivery + correct authorship | ✅ PASS — attributed to the actor, correct timestamp |
| Socket **authenticates as the user** | ✅ PASS — token JWT `role: authenticated`, real `sub`, hosted issuer |
| **Refresh token never exposed** (only short-lived access token) | ✅ PASS — verified in `route-core.ts` + live 200 on `/auth/realtime-token` |
| **RLS-as-user holds on the socket, not just the anon join** | ✅ PASS — filter-removed anon socket **joined** but received **zero** events; authenticated socket received them |
| Reaction **DELETE** (un-react) propagation | ❌ FAIL → **#63** |
| New-proposal live propagation | ➖ out of scope → **#64** |
| Two-*real*-household live socket exclusion | ⏭️ not run (no second household account available) — follow-up |

### Evidence highlights

- The `/auth/realtime-token` JWT decoded live to `aud/role: "authenticated"` with a real
  `sub`, issued by `https://wcbjuobzeursmomcoefw.supabase.co/auth/v1` — i.e. the socket
  credential is a genuine **user** token, not anon. The refresh token stays in the httpOnly
  cookie (`route-core.ts` returns only the access token).
- In the socket probe both sockets reported `JOIN OK` + "Subscribed to PostgreSQL". On an
  actor INSERT, **only** the authenticated socket logged the event (carrying the household's
  `household_id`); the anon socket logged nothing. A first run was **discarded** because the
  authenticated control's token had expired (a limitation of the hand-rolled probe, not the
  app); the re-run added token refresh and produced a valid positive control.

## Decision

**Production Realtime is trusted** for the verified properties: INSERT delivery of reactions
and comments on hosted Supabase, socket authentication as the signed-in user, non-exposure
of the refresh token, and RLS enforcement on the socket (an under-authorized/anon join
harvests no events). The ADR 0008 invariant holds on cloud, not just locally.

**Gate is PASS with one required pre-family fix:** **#63** (un-reacting does not propagate)
must land before the family relies on reactions, because reaction toggling is central to the
propose-and-react loop and a dropped un-react leaves other members showing a phantom
reaction (and a stale nudge-sort order) until a revalidation. It is a scoped fix, not a
reason to distrust the deployment.

## Findings (filed as issues)

- **#63 (bug, required before family use).** Reaction `DELETE` events never reach other
  clients. Root cause: `reactions`/`comments` are published with **default replica identity
  (primary key only)**, so a `DELETE` carries only `id`; the household-scoped subscription
  filter and RLS both reference `household_id`, which is absent from the DELETE image, so
  Realtime drops the event. Fix: `alter table … replica identity full` on both tables, plus a
  DELETE-propagation regression test (the existing component test mocks the channel and only
  ever exercised INSERT — which is why this shipped). Symptom cascade: the cross-device
  nudge-sort mismatch we observed is downstream of this (order derives from reaction counts).
- **#64 (enhancement, scope).** New dish **proposals** do not appear live — the channel
  subscribes only to `reactions`/`comments`, not `proposals`. Correct-without-Realtime by
  design; extending the live layer to proposal inserts is a scoped enhancement.

## Follow-ups / residual risk

- **Cross-household live socket exclusion was not demonstrated** (no second, separate
  household account was available at gate time). Residual risk is **low**: cross-household
  denial at the DB is covered by the **required RLS pgTAP** CI check, and this gate proved
  RLS is enforced **on the socket as the user** (anon join received nothing with the filter
  removed). Recommended follow-up: when a second account (or a controlled test env with two
  households) is available, repeat the filter-removed socket probe with a genuine second
  household emitting, and confirm the authenticated socket for household A never receives
  household B's events.
- The gate result is recorded here; #54 is Done once this ADR merges.
