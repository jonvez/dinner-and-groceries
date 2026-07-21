# CI / CD

GitHub Actions pipeline for `dinner-and-groceries`. Implements ADR 0003's
CI/deploy posture. Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What runs, when

| Trigger | Job | What it does |
|---------|-----|--------------|
| Every PR (+ push to `main`) | `verify` | `npm run lint`, `npm run typecheck`, `npm test` (Vitest). Any failure exits non-zero and **blocks merge**. |
| Every PR (+ push to `main`) | `e2e` | `npm run build` (standalone) → install Chromium → `npm run test:e2e` (Playwright smoke: `/` loads and renders). |
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
npm run build     # produces the standalone server
npm run test:e2e  # Playwright smoke (boots the standalone server itself)
```

`npm run test:e2e` requires a prior `npm run build` (the Playwright `webServer`
boots `start:standalone`, which serves `.next/standalone/server.js`).

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
  come from `supabase status` once #2 lands.
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

## #2 seam (ephemeral Supabase for E2E)

The smoke E2E runs against `next start`'s standalone server **without** Supabase,
so it is green today. The `e2e` job has a guarded "Start ephemeral Supabase" step
(`if: hashFiles('supabase/config.toml') != ''`) marked `TODO(#2)`. Once #2 merges
`supabase/`, that step boots an ephemeral local stack and exports its URL/anon key
into the E2E environment — no further workflow surgery needed.
