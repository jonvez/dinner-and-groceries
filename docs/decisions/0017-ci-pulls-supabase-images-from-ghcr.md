# ADR 0017 — CI pulls the Supabase stack images from `ghcr.io`, authenticated with the job's `GITHUB_TOKEN`

- **Status:** Accepted
- **Date:** 2026-10-15
- **Decided by:** **Jon** approved the approach and chose `docker/login-action` (with a
  `third-party-security-review`: Accept-with-hardening, LOW) over a plain `docker login` step
  (2026-10-15).
- **Relates to:** #236 (this issue), #98 (the earlier, narrower fix), ADR 0009 (no long-lived
  credentials in GitHub), ADR 0015 (merged ≠ in production), #164 (CLI pinned at 2.107.0), PLAN.md
  Active Context (CI gotchas).

## Context

The `rls` (pgTAP) and `e2e` jobs boot a local Supabase stack with `supabase start`, which pulls 13
images, and `supabase test db` pulls a 14th (`pg_prove`). On 2026-10-15, four `main` runs failed in a
single day on `toomanyrequests: Data limit exceeded` across every image. Each time the code was
green everywhere else. A failed `main` run also **skips the deploy**, so this was re-opening the
gap ADR 0015 closed.

**The diagnosis everyone had was wrong.** #98, #236 and the PLAN.md gotcha all blamed anonymous
**Docker Hub** pulls. But at our pinned CLI (2.107.0), `GetRegistry()` defaults to
**`public.ecr.aws`**, and every failing pull in the logs names that host. The real limit is **ECR
Public's anonymous data quota**, keyed by source IP and shared with every other GitHub customer's
runners. Nothing in our own usage could keep us under it on a busy day.

#236 listed three fixes, each with a real cost: a Docker Hub token (a long-lived credential,
against ADR 0009, and the wrong registry anyway), caching about 13 images in `actions/cache` (large,
and needing a careful key), or mirroring into our own Artifact Registry (the most work).

## Decision

The CLI supports a mirror: `SUPABASE_INTERNAL_IMAGE_REGISTRY=<host>` maps every image to
`<host>/supabase/<name>:<tag>`. Supabase publishes the same images to **`ghcr.io/supabase/`**. All 17
images that CLI 2.107.0 pins were verified there at the exact tags on 2026-10-15.

In the `rls` and `e2e` jobs:

- `env: SUPABASE_INTERNAL_IMAGE_REGISTRY: ghcr.io`, at job level, so `start`, `db reset`, `test db`
  and `stop` all agree;
- `permissions: packages: read`, **per job**, not at workflow level;
- `docker/login-action` (SHA-pinned v4.6.0) logs in to `ghcr.io` with `${{ github.token }}`, which is
  short-lived, run-scoped and read-only. **No new secret, nothing long-lived**, so ADR 0009 holds;
- the pgTAP pre-pull warms `ghcr.io/supabase/pg_prove:3.36`, the name `test db` now asks for;
- `scripts/ci/supabase-start.sh` replaces the two inline retry loops. It retries transient failures
  but **fails fast on `toomanyrequests`**. A rate limit counts attempts, so retrying spent the quota
  it was waiting for: about 78 pulls per logical run, with a 5-minute failure turned into a 12-minute
  one.

Local development is unchanged. A laptop's own IP doesn't share that quota.

## Consequences

- CI pulls are authenticated against GitHub's own registry from GitHub's own runners, so the shared
  anonymous quota no longer applies.
- The source of trust is the same publisher (Supabase's `ghcr.io/supabase` org instead of its ECR
  Public alias), so the supply chain isn't widened.
- **A Supabase CLI bump must check that every image it pins exists on `ghcr.io/supabase/`.** If one is
  missing, `supabase start` fails on that bump's own PR, which is loud rather than silent. The
  check is a manifest `HEAD` per image.
- If a rate limit ever fires again, `supabase-start.sh` says so in one line and names this ADR,
  instead of three slow retries that look like a flaky test.
- #98's closing note and #236's original framing are corrected to point here.

## Verification

- Local, from a cold cache of `ghcr.io` image names: `supabase start` pulled all 13 images from
  `ghcr.io`, and all 12 running containers were `ghcr.io/supabase/*`. `test db` pulled
  `ghcr.io/supabase/pg_prove:3.36` and passed 213 tests in 23 files. The authed Playwright suite
  passed 39/39 against that stack.
- `scripts/ci/supabase-start.test.ts`: 5 tests, written first. Covers first-try success, a
  transient retry with cleanup, giving up after 3, fail-fast on a rate limit, and that the CLI's own
  output stays visible.
- CI: back-to-back runs of the `rls` + `e2e` jobs on the PR, recorded in the PR.
