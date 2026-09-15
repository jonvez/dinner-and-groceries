# CI / CD

GitHub Actions pipeline for `dinner-and-groceries`. Implements ADR 0003's
CI/deploy posture. Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What runs, when

| Trigger | Job | What it does |
|---------|-----|--------------|
| Every PR (+ push to `main`) | `verify` | `npm run lint`, `npm run typecheck`, `npm test` (Vitest). Any failure exits non-zero and **blocks merge**. |
| Every PR (+ push to `main`) | `e2e` | Boot ephemeral local Supabase → export its URL/anon key → `npm run build` (standalone, bundle inlined against the local stack) → install Chromium → `npm run test:e2e` (Playwright: signed-out smoke **plus** the authenticated loop — board render, propose/react/comment, and a two-context live Realtime guard). |
| Merge to `main` only | `migrate` | Applies `supabase/migrations/` to the cloud Supabase **prod** database (`supabase db push`), then asserts prod's history matches the repo. Runs **before** `deploy`. Guarded; no-op only while GCP wiring vars are unset. See [`migrate` — prod migrations](#migrate--prod-migrations-adr-0015). |
| Merge to `main` only | `deploy` | Docker build → Artifact Registry → Cloud Run (WIF auth). `needs: migrate`, so a failed apply skips the deploy. Guarded; no-op only while GCP wiring vars are unset. |

Both `migrate` and `deploy` have
`if: github.ref == 'refs/heads/main' && github.event_name == 'push'`, so neither
runs on PRs. Even on `main` each first checks `vars.GCP_PROJECT_ID`; if unset it
prints a notice and no-ops. Nothing fails a PR, and no GCP creds are committed.

### Concurrency: PRs cancel, `main` queues

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

Superseded **PR** runs are still cancelled (that is where the CI-minute saving
comes from), but `main` runs **queue**, because a `main` run applies migrations to
prod and cancelling one mid-apply is not something to design in. The `migrate`
job additionally holds its own `concurrency: { group: prod-migrate,
cancel-in-progress: false }`, so prod applies never overlap regardless of trigger
(including a manual re-run of an older run).

## Local equivalents

```bash
npm run lint
npm run typecheck
npm test          # Vitest unit tests
npm run db:start  # local Supabase (required for the authed E2E tier)
npm run build     # produces the standalone server (inlines NEXT_PUBLIC_* — see below)
npm run test:e2e  # Playwright smoke + authed loop (boots the standalone server itself)
```

`npm run test:e2e` requires a prior `npm run build` (the Playwright `webServer`
boots `start:standalone`, which serves `.next/standalone/server.js`). The
**authed** tier additionally needs a running local Supabase (`npm run db:start`):
the Playwright `setup` project seeds two email/password users into one household
and persists each session as a `storageState`, so the authed tests start
signed-in with no Google OAuth. Build with the local Supabase env inlined, e.g.
`NEXT_PUBLIC_SUPABASE_URL=$(…) NEXT_PUBLIC_SUPABASE_ANON_KEY=$(…) npm run build`
(the values print from `npm run db:status`). The signed-out **smoke** tier needs
no backend.

## Node version

Pinned via [`.nvmrc`](../.nvmrc) (Node 22). CI reads it through
`actions/setup-node` `node-version-file`.

## Supply-chain pinning (#23)

Every third-party GitHub Action in `ci.yml` is pinned to an **immutable 40-char
commit SHA** (with a trailing `# vX.Y.Z` comment for the human-readable version),
not a mutable tag — a moved tag can't silently swap the action out from under a
run. The `Dockerfile` base image is **digest-pinned** (`node:22-slim@sha256:…`)
on all stages for the same reason. To bump either, resolve the new SHA/digest
deliberately (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`;
`docker buildx imagetools inspect node:22-slim`) and update the pin + comment.

## Secrets & deploy wiring (no secrets in the repo)

Secrets are **never** committed. Two sources:

- **Local dev:** copy `.env.example` → `.env.local` (gitignored). Supabase values
  come from `npm run db:status` (the well-known non-secret local CLI defaults).
- **Production (Cloud Run):** the two `NEXT_PUBLIC_*` values live in **GCP Secret
  Manager** (canonical names below) and are wired into **both** the build and the
  runtime — because they are consumed on two paths:
  - **Client bundle (build time):** Next.js inlines *static* `process.env.NEXT_PUBLIC_*`
    references at build, so the deploy job fetches the values and passes them to
    `docker build` as `--build-arg`s.
  - **Server (runtime):** `proxy.ts` / `server-component.ts` call
    `readSupabaseEnv()`, which reads `process.env` **dynamically** — dynamic reads
    are *not* inlined by the build, so the running container must carry them in its
    env, bound from Secret Manager on the `deploy-cloudrun` step.

  **Both are required.** Build-args only ⇒ the SSR middleware throws
  `Missing required Supabase env var(s)` and every request 500s. Runtime-only ⇒ the
  browser sign-in client has no config and throws. The workflow references secret
  *names*, never values, and the values never appear in logs. The **service-role**
  key is never fetched, built in, or bound anywhere.

### `NEXT_PUBLIC_*` flow (Secret Manager → build-arg *and* runtime binding)

1. `google-github-actions/auth@v3` authenticates as the deploy SA via WIF.
2. The **Fetch build-time NEXT_PUBLIC_\*** step runs
   `gcloud secrets versions access latest --secret=<NAME>` for both secrets and
   writes them into `$GITHUB_ENV`.
3. `docker/build-push-action@v7` passes them as `build-args`; the `Dockerfile`
   builder stage declares matching `ARG`/`ENV` so `next build` inlines them into
   the **client** bundle.
4. The `deploy-cloudrun` step binds them as Cloud Run **runtime** secrets
   (`secrets:` mapping to `<NAME>:latest`) for the **server** path.

This requires the **deploy SA** to hold `roles/secretmanager.secretAccessor` on
both secrets (build-time fetch, runbook § P3) **and** the runtime compute SA to
hold it too (runtime binding, runbook § P1.6).

The deploy job is enabled by these **repository variables** (Settings → Secrets
and variables → Actions → Variables) — non-sensitive identifiers only; setting
`GCP_PROJECT_ID` flips the gate on:

| Variable | Example | Purpose |
|----------|---------|---------|
| `GCP_PROJECT_ID` | `dinner-and-groceries` | GCP project; also the gate that enables deploy. |
| `GCP_REGION` | `us-central1` | Artifact Registry + Cloud Run region. |
| `GCP_AR_REPO` | `app` | Artifact Registry repository name. |
| `GCP_WIF_PROVIDER` | `projects/123/locations/global/workloadIdentityPools/gh/providers/gh` | Workload Identity Federation provider. |
| `GCP_DEPLOY_SA` | `deployer@…iam.gserviceaccount.com` | Service account the workflow impersonates. |

Authentication uses **Workload Identity Federation** (keyless) — no long-lived
JSON service-account keys are stored in GitHub. The canonical Secret Manager
secrets the build reads (see the build-time flow above):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### `migrate` — prod migrations (ADR 0015)

Decision of record: **ADR 0015**. Setup, rotation and the red-run playbook:
**`docs/runbooks/prod-migrations.md`**.

On every push to `main`, after `verify` + `rls` + `e2e` pass, the `migrate` job
applies `supabase/migrations/` to the cloud Supabase prod database. "Merged" now
means "applied" — before this, prod's schema moved only when a human remembered
a manual `supabase db push` (the footgun behind #63 and the 2026-08-12 retro).

```
npx supabase migration list --db-url "$SUPABASE_MIGRATION_DB_URL"   # pre-flight: log prod's state
npx supabase db push        --db-url "$SUPABASE_MIGRATION_DB_URL" --yes
npx supabase migration list --db-url "$SUPABASE_MIGRATION_DB_URL"   # post-flight: parsed + asserted
```

**The secret: `SUPABASE_MIGRATION_DB_URL`** — the prod **session-pooler**
connection URI (port **5432**; the 6543 transaction pooler cannot run DDL).

| Property | Value |
|---|---|
| Lives in | **GCP Secret Manager only.** Never a GitHub Actions secret, never `.env*`, never in the image. |
| Read by | The **deploy SA**, via the same keyless WIF exchange `deploy` uses. `roles/secretmanager.secretAccessor` is granted to that SA **and nothing else**. |
| Bound to Cloud Run | **Never.** The running app must not hold a credential that bypasses RLS (ADR 0003). Guarded by `ci-migrate-job.test.ts`. |
| In logs | Masked with `::add-mask::` before it can reach any later log line. `--debug` is **banned** in this job — it prints the connection string. |
| Reachable from a PR | No. The job is `push`-to-`main` only, so no PR (least of all a fork's) can reach it. |
| Rotation | Reset the DB password, then `gcloud secrets versions add`. The job reads `:latest`, so no repo or workflow change. |

No new GitHub secret and no new repo variable exist — ADR 0009's "nothing
long-lived in GitHub" invariant is intact. The gate is the existing
`vars.GCP_PROJECT_ID`, so `migrate` is a visible no-op stub until wiring is done.

**Ordering — migrate *before* deploy.** `deploy` has `needs: migrate`, so a
failed apply skips the deploy and prod keeps old code on old schema: coherent,
nothing half-shipped. Deploying first would guarantee a window of *new code on
old schema*, which is the failure this project has already shipped twice.
`migrate` has `needs: [verify, rls, e2e]` — in particular **`rls`**, so no
migration reaches prod on a commit whose pgTAP allow/deny suite did not pass.
Required checks gate *merges*; this gates the *apply*.

#### The expand-only migration rule

**A migration merged to `main` must be backward compatible with the currently
deployed app.** Migrate-first means the old container keeps serving against the
new schema for the length of the deploy — fine for an additive change, broken for
a narrowing one. So a **contracting** change (drop/rename a column, tighten an
RLS policy the live app relies on) ships as **two PRs**:

1. the app stops depending on the thing, and deploys;
2. *then* the contracting migration merges.

This is the price of migrate-first with no staging tier. Related authoring rules:
applied migrations are **immutable** (fix forward — the CLI silently ignores edits
to a file already in the history table, so a changed applied file is invisible
drift); no statements that cannot run inside a transaction
(`CREATE INDEX CONCURRENTLY`, `VACUUM`), since each file is wrapped in one; and
consider opening a migration with `set local lock_timeout = '5s';`.

#### Drift is fail-closed

`db push` is itself the drift gate — both drift classes exit **1** and therefore
block the deploy, including for an unrelated docs-only merge, until a human
repairs the history (runbook § 3):

| Drift | CLI says | Fix |
|---|---|---|
| **Remote-ahead** — prod has a version the repo lacks (hand-applied SQL, or a branch that never merged) | `Remote migration versions not found in local migrations directory` | Merge the branch, or `migration repair --status reverted <version>` |
| **Out-of-order** — a pending file whose timestamp precedes prod's history head (the two-developer merge race) | `Found local migration files to be inserted before the last migration on remote database` | Rename the file to a later timestamp, then `npx supabase db reset --local`. The workflow must **never** pass `--include-all`. |

`migration list` **always exits 0**, so the post-flight step *parses* its
pipe-delimited rows and fails on any blank cell on either side. With it, a green
`migrate` means the repo's migration history **is** prod's migration history.

Two limits, stated rather than hidden: an **edited already-applied** migration is
undetectable, and `migration list` compares *history*, not *schema* — a change
made in the dashboard SQL editor that never touches
`supabase_migrations.schema_migrations` goes unnoticed. A scheduled prod invariant
check is the named follow-up.

The out-of-order class is also caught **at PR time**, before it can ever red
`main`: `migrations-monotonic.test.ts` (in `verify`, no credentials) asserts that
every migration a branch **adds** sorts after every migration already on the base
branch. That comparison needs the merge base, which is why `verify` checks out
with `fetch-depth: 0`.

#### No path filter on `migrate`

The docs-only fast-path (#99) is deliberately **not** extended to this job. `db
push` with nothing pending is a sub-second no-op (`Local database is up to date.`,
exit 0), so running it unconditionally costs almost nothing and buys two things: a
path-filter bug can never silently skip a real migration (that failure mode fails
*open*, which is unacceptable here), and every merge becomes a standing assertion
that prod's history matches the repo.

## Ephemeral Supabase for E2E (#24 / #56)

The `e2e` job boots a **real ephemeral local Supabase** and runs the authenticated
loop against it. Step order is deliberate because `NEXT_PUBLIC_*` are inlined into
the **client bundle at build time** (this repo has been bitten by that repeatedly):

1. `npx supabase start` (Google OAuth env is a harmless placeholder — the flows
   never touch Google).
2. Export the running stack's `API_URL`/`ANON_KEY` (from `supabase status -o env`)
   into `$GITHUB_ENV` as `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` — the single source
   of truth for build, the standalone server, and the seed.
3. `supabase db reset --local` (clean, migrated schema).
4. `npm run build` — the client bundle is inlined pointing at the local stack.
5. A guard step greps `.next/static/chunks` to **prove** the local URL was inlined
   (fails fast on the exact bundle-drift class this seam exists to prevent).
6. `npm run test:e2e` — the Playwright `setup` project seeds two email/password
   users into one household via the app's own authenticated RPCs, writes each
   session as a `storageState`, and the authed + Realtime specs run.
7. `supabase stop --no-backup` (always).

**Security (ADR 0003 intact):** there is **no service-role key** anywhere in this
job. Local Supabase disables email confirmations, so `auth.signUp` returns a live
session immediately; the household is built entirely as the signed-in users under
RLS. The seed logic lives in `e2e/support/seed.ts`.
