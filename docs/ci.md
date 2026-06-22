# CI / CD

GitHub Actions pipeline for `dinner-and-groceries`. Implements ADR 0003's
CI/deploy posture. Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What runs, when

| Trigger | Job | What it does |
|---------|-----|--------------|
| Every PR (+ push to `main`) | `verify` | `npm run lint`, `npm run typecheck`, `npm test` (Vitest). Any failure exits non-zero and **blocks merge**. |
| Every PR (+ push to `main`) | `e2e` | `npm run build` (standalone) → install Chromium → `npm run test:e2e` (Playwright smoke: `/` loads and renders). |
| Merge to `main` only | `deploy` | **Stub.** Docker build → Artifact Registry → Cloud Run. Guarded; no-op until GCP wiring vars are set. |

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

## Secrets & deploy wiring (no secrets in the repo)

Secrets are **never** committed. Two sources:

- **Local dev:** copy `.env.example` → `.env.local` (gitignored). Supabase values
  come from `supabase status` once #2 lands.
- **Production (Cloud Run):** bound from **GCP Secret Manager** at deploy time via
  the `deploy-cloudrun` action's `secrets:` mapping (`NAME=SECRET:latest`). The
  workflow references secret *names*, not values.

To activate the deploy stub, set these **repository variables** (Settings →
Secrets and variables → Actions → Variables) — non-sensitive identifiers only:

| Variable | Example | Purpose |
|----------|---------|---------|
| `GCP_PROJECT_ID` | `dinner-and-groceries-prod` | GCP project; also the gate that enables deploy. |
| `GCP_REGION` | `us-central1` | Artifact Registry + Cloud Run region. |
| `GCP_AR_REPO` | `app` | Artifact Registry repository name. |
| `GCP_WIF_PROVIDER` | `projects/123/locations/global/workloadIdentityPools/gh/providers/gh` | Workload Identity Federation provider. |
| `GCP_DEPLOY_SA` | `deployer@…iam.gserviceaccount.com` | Service account the workflow impersonates. |

Authentication uses **Workload Identity Federation** (keyless) — no long-lived
JSON service-account keys are stored in GitHub. The Secret Manager secrets the
service expects (placeholders today, finalized with #2):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## #2 seam (ephemeral Supabase for E2E)

The smoke E2E runs against `next start`'s standalone server **without** Supabase,
so it is green today. The `e2e` job has a guarded "Start ephemeral Supabase" step
(`if: hashFiles('supabase/config.toml') != ''`) marked `TODO(#2)`. Once #2 merges
`supabase/`, that step boots an ephemeral local stack and exports its URL/anon key
into the E2E environment — no further workflow surgery needed.
