# CI / CD

GitHub Actions pipeline for `dinner-and-groceries`. Implements ADR 0003's
CI/deploy posture. Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What runs, when

| Trigger | Job | What it does |
|---------|-----|--------------|
| Every PR (+ push to `main`) | `verify` | `npm run lint`, `npm run typecheck`, `npm test` (Vitest). Any failure exits non-zero and **blocks merge**. |
| Every PR (+ push to `main`) | `e2e` | Boot ephemeral local Supabase → export its URL/anon key → `npm run build` (standalone, bundle inlined against the local stack) → install Chromium → `npm run test:e2e` (Playwright: signed-out smoke **plus** the authenticated loop — board render, propose/react/comment, and a two-context live Realtime guard). |
| Merge to `main` only | `deploy` | Docker build → Artifact Registry → Cloud Run (WIF auth). Guarded; no-op only while GCP wiring vars are unset. |

The `deploy` job has `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`,
so it never runs on PRs. Even on `main` it first checks `vars.GCP_PROJECT_ID`; if
unset it prints a notice and no-ops. Nothing fails a PR, and no GCP creds are
committed.

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
  - **Server (runtime):** `middleware.ts` / `server-component.ts` call
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
