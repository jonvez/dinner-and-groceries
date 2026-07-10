# Production bring-up runbook — P0, P1, P2, P3 prerequisite (Jon-run, credentialed)

Step-by-step guide for the **credentialed blockers** of the M1 production slice (#46).
These are the steps **Jon runs personally** — agents do not run `gcloud`/`supabase`
against real cloud resources. P3/P5/P7 are agent work, but **P3 has one credentialed
prerequisite** (§ P3 below) Jon must run before the first deploy; the rest of P3 and the
ADRs are handled by the team.

- Posture of record: **ADR 0009** (deploy topology + keyless WIF) and **ADR 0010**
  (cloud Supabase as prod).
- Issues: **#50 (P0)**, **#51 (P1)**, **#52 (P2)**, **#53 (P3, activate deploy)**. Parent: **#46**.

> **Project-id note:** the sections below still spell the project `dinner-and-groceries-prod`;
> the real project id is **`dinner-and-groceries`** and the rename is in flight (docs PR #58).
> The **§ P3** commands added here already use the correct `dinner-and-groceries`. The deploy
> workflow itself reads `${{ vars.GCP_PROJECT_ID }}`, so it is unaffected either way.

## Fixed values (settled — do not change)

| Thing | Value |
|-------|-------|
| GCP project id | `dinner-and-groceries-prod` |
| Region | `us-central1` |
| Artifact Registry repo | `app` (Docker format) |
| Cloud Run service | `dinner-and-groceries` |
| GitHub repo (WIF pin) | `jonvez/dinner-and-groceries` |
| Secret Manager secret names | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Repo variable names (match `ci.yml`) | `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_AR_REPO`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA` |

## Placeholders (Jon fills in)

| Placeholder | Where it comes from |
|-------------|---------------------|
| `<BILLING_ACCOUNT_ID>` | Jon's GCP billing account (`gcloud billing accounts list`) |
| `<PROJECT_NUMBER>` | Printed after project creation / `gcloud projects describe` |
| `<project-ref>` | The prod Supabase project ref (from its dashboard URL), P1 |
| `<RUN_APP_URL>` | The `https://<service>.run.app` URL — **not known until the first deploy (P3)** |
| `<GOOGLE_CLIENT_ID>` / `<GOOGLE_CLIENT_SECRET>` | From the prod OAuth client, P2 |

> Naming note (resolves the `ci.yml` "TODO: align secret names"): the canonical Secret
> Manager names are `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — exactly
> what the `deploy` job's `secrets:` mapping already references. No workflow change needed.

---

## P0 — GCP project + Artifact Registry + deploy SA + keyless WIF (issue #50)

### 0.1 Create the project and link billing
```
gcloud projects create dinner-and-groceries-prod --name="Dinner and Groceries (prod)"
```
```
gcloud billing projects link dinner-and-groceries-prod --billing-account=<BILLING_ACCOUNT_ID>
```
```
gcloud config set project dinner-and-groceries-prod
```
Capture the project number (used later for the WIF principalSet):
```
gcloud projects describe dinner-and-groceries-prod --format="value(projectNumber)"
```

### 0.2 Enable the required APIs
```
gcloud services enable run.googleapis.com --project=dinner-and-groceries-prod
```
```
gcloud services enable artifactregistry.googleapis.com --project=dinner-and-groceries-prod
```
```
gcloud services enable iam.googleapis.com --project=dinner-and-groceries-prod
```
```
gcloud services enable secretmanager.googleapis.com --project=dinner-and-groceries-prod
```
```
gcloud services enable cloudresourcemanager.googleapis.com --project=dinner-and-groceries-prod
```

### 0.3 Create the Artifact Registry repo (Docker, us-central1)
```
gcloud artifacts repositories create app --repository-format=docker --location=us-central1 --description="Dinner and Groceries container images" --project=dinner-and-groceries-prod
```

### 0.4 Create the least-privilege deploy service account
```
gcloud iam service-accounts create deployer --display-name="GitHub Actions deployer (WIF)" --project=dinner-and-groceries-prod
```
Grant exactly the three deploy roles (no owner/editor):
```
gcloud projects add-iam-policy-binding dinner-and-groceries-prod --member="serviceAccount:deployer@dinner-and-groceries-prod.iam.gserviceaccount.com" --role="roles/run.admin"
```
```
gcloud projects add-iam-policy-binding dinner-and-groceries-prod --member="serviceAccount:deployer@dinner-and-groceries-prod.iam.gserviceaccount.com" --role="roles/artifactregistry.writer"
```
```
gcloud projects add-iam-policy-binding dinner-and-groceries-prod --member="serviceAccount:deployer@dinner-and-groceries-prod.iam.gserviceaccount.com" --role="roles/iam.serviceAccountUser"
```

> The Cloud Run **runtime** SA is the project's default compute SA
> (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`), matching `ci.yml` which sets
> no runtime-SA override. It receives `secretmanager.secretAccessor` in **P1 step 1.6**
> (scoped to the two Supabase secrets). The deploy SA's `iam.serviceAccountUser` above lets
> it actAs that runtime SA during `deploy-cloudrun`.

### 0.5 Create the WIF pool + provider, pinned to this repo
```
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions pool" --project=dinner-and-groceries-prod
```
Create the OIDC provider with the **repo-pinned attribute condition** (ADR 0009 requires
`repository == jonvez/dinner-and-groceries`):
```
gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github --display-name="GitHub Actions provider" --issuer-uri="https://token.actions.githubusercontent.com" --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --attribute-condition="assertion.repository == 'jonvez/dinner-and-groceries'" --project=dinner-and-groceries-prod
```

### 0.6 Bind the deploy SA to the repo's WIF identity (scoped principalSet)
```
gcloud iam service-accounts add-iam-policy-binding deployer@dinner-and-groceries-prod.iam.gserviceaccount.com --role="roles/iam.workloadIdentityUser" --member="principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/attribute.repository/jonvez/dinner-and-groceries" --project=dinner-and-groceries-prod
```

### 0.7 Set the GitHub repo variables (match `ci.yml`; non-sensitive identifiers only)
The full WIF provider resource name is:
`projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github`
```
gh variable set GCP_PROJECT_ID --body "dinner-and-groceries-prod" --repo jonvez/dinner-and-groceries
```
```
gh variable set GCP_REGION --body "us-central1" --repo jonvez/dinner-and-groceries
```
```
gh variable set GCP_AR_REPO --body "app" --repo jonvez/dinner-and-groceries
```
```
gh variable set GCP_WIF_PROVIDER --body "projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github" --repo jonvez/dinner-and-groceries
```
```
gh variable set GCP_DEPLOY_SA --body "deployer@dinner-and-groceries-prod.iam.gserviceaccount.com" --repo jonvez/dinner-and-groceries
```

> Setting `GCP_PROJECT_ID` **flips the deploy job's gate on**. Do this only when P0 is
> complete (and ideally P1 too, so the first deploy has its secrets).

**P0 done when:** APIs enabled, `app` repo exists, deploy SA has exactly the 3 roles, the
WIF provider's attribute condition contains `assertion.repository == 'jonvez/dinner-and-groceries'`,
the SA has the scoped `workloadIdentityUser` binding, and the 5 repo variables are set.

---

## P1 — Cloud Supabase as prod (issue #51)

### 1.1 Create the prod project (Free tier, us-central1)
In the Supabase dashboard: **New project** → Organization = Jon's → Name e.g.
`dinner-and-groceries-prod` → **Region: us-central1** (or closest offered; keep it central)
→ **Plan: Free** → generate a DB password (store in Jon's password manager). Copy the
**project ref** (`<project-ref>`, the subdomain of the project URL).

### 1.2 Link the local repo to the prod project
```
supabase link --project-ref <project-ref>
```

### 1.3 Apply the migrations to the cloud DB
```
supabase db push
```
This applies everything in `supabase/migrations/` — the same DDL CI applies locally via
`supabase db reset`. RLS parity is by construction (ADR 0010).

### 1.4 Verify the Realtime publication migration landed
Confirm `reactions` and `comments` are in the `supabase_realtime` publication (dashboard
SQL editor, or psql with the connection string):
```
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename;
```
Expect rows for `reactions` and `comments` (and any others the migration adds).

### 1.5 Confirm FORCE RLS on household-scoped tables
```
select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity order by relname;
```
Every household-scoped table must show `relforcerowsecurity = t`. (If any is `f`, the
migration that sets `FORCE ROW LEVEL SECURITY` did not apply — stop and investigate before
loading data.)

### 1.6 Load the prod anon URL + anon key into Secret Manager
From the Supabase dashboard: **Project Settings → API** → copy the **Project URL** and the
**anon public** key. Create the secrets under the canonical names and grant the Cloud Run
runtime SA access:
```
printf '%s' 'https://<project-ref>.supabase.co' | gcloud secrets create NEXT_PUBLIC_SUPABASE_URL --data-file=- --project=dinner-and-groceries-prod
```
```
printf '%s' '<ANON_PUBLIC_KEY>' | gcloud secrets create NEXT_PUBLIC_SUPABASE_ANON_KEY --data-file=- --project=dinner-and-groceries-prod
```
Grant the runtime (default compute) SA read access to each secret:
```
gcloud secrets add-iam-policy-binding NEXT_PUBLIC_SUPABASE_URL --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=dinner-and-groceries-prod
```
```
gcloud secrets add-iam-policy-binding NEXT_PUBLIC_SUPABASE_ANON_KEY --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=dinner-and-groceries-prod
```
> To rotate later: `gcloud secrets versions add <NAME> --data-file=-` (the `deploy-cloudrun`
> mapping uses `:latest`, so a new version is picked up on the next deploy).
> **Never** load the service-role key here — only the anon key + public URL (ADR 0010).

### 1.7 Two-user cloud smoke (RLS parity confirmation)
After P2 + first deploy, sign in as two members and confirm each sees only household-scoped
rows (no cross-household leakage), matching the pgTAP allow-same/deny-cross contract.

**P1 done when:** migrations pushed with no drift, Realtime publication verified, FORCE RLS
confirmed, both secrets exist with the runtime SA holding `secretAccessor`, and the
two-user smoke passes.

---

## P2 — Production Google OAuth (issue #52)

> **Chicken-and-egg:** the `<RUN_APP_URL>` is not known until the **first deploy (P3)**. The
> redirect URI only needs `<project-ref>` (known from P1), so do it first; set the JS origin
> and Supabase Site URL after the first deploy, then redeploy.

### 2.1 Create the prod OAuth Web client (redirect URI is fixed)
Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client
ID → Web application**. Name e.g. `dinner-and-groceries-prod`. Set the **Authorized redirect
URI** exactly to:
```
https://<project-ref>.supabase.co/auth/v1/callback
```
Leave **Authorized JavaScript origins** empty for now (filled in step 2.4). Copy the
`<GOOGLE_CLIENT_ID>` and `<GOOGLE_CLIENT_SECRET>`.

### 2.2 Load the client id/secret into the hosted Supabase Auth settings
Supabase dashboard → **Authentication → Providers → Google** → enable → paste
`<GOOGLE_CLIENT_ID>` and `<GOOGLE_CLIENT_SECRET>` → save. (These live only in Supabase Auth —
never in the repo, app env, or Cloud Run secrets.)

### 2.3 First deploy (P3) to obtain the run.app URL
Once P0/P1 are done and the deploy activates (P3), the merge-to-`main` deploy produces
`<RUN_APP_URL>` = `https://dinner-and-groceries-<hash>-uc.a.run.app`. Read it:
```
gcloud run services describe dinner-and-groceries --region=us-central1 --project=dinner-and-groceries-prod --format="value(status.url)"
```

### 2.4 Set the JS origin + Supabase Site URL to the run.app URL, then redeploy
- Google OAuth client → **Authorized JavaScript origins** → add `<RUN_APP_URL>` (scheme +
  host, no path).
- Supabase → **Authentication → URL Configuration** → set **Site URL** = `<RUN_APP_URL>` and
  add `<RUN_APP_URL>` to **Redirect URLs**.
- Redeploy if the app needs the origin at build/runtime.

### 2.5 Add the family as test users
Google Cloud Console → **OAuth consent screen → Test users** → add Jon + the two kids'
Google addresses. Until an explicit launch decision, only these three can sign in.

**P2 done when:** the redirect URI is exactly the Supabase callback, Google is enabled in
Supabase Auth, the JS origin + Site URL are the `run.app` URL, a real Google round-trip on
`<RUN_APP_URL>` lands a user in the household, and the three test users are configured.

---

## P3 — Activate the Cloud Run deploy (issue #53)

Most of P3 is agent work (the workflow + Dockerfile changes in #53). But there is **one
credentialed prerequisite Jon must run before the first deploy**, plus the deploy mechanism
to understand.

### 3.1 (prerequisite) Grant the **deploy SA** read access to the two secrets

With the chosen build-time design (**Option A**), the `NEXT_PUBLIC_*` values are inlined
into the client bundle at **Docker build time** — so the workflow reads them from Secret
Manager **as the deploy SA** during the build (not the runtime compute SA at boot). P0 gave
the deploy SA `run.admin` / `artifactregistry.writer` / `iam.serviceAccountUser` but **not**
`secretmanager.secretAccessor`, so grant it now on both secrets:

```
gcloud secrets add-iam-policy-binding NEXT_PUBLIC_SUPABASE_URL --member="serviceAccount:deployer@dinner-and-groceries.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=dinner-and-groceries
```
```
gcloud secrets add-iam-policy-binding NEXT_PUBLIC_SUPABASE_ANON_KEY --member="serviceAccount:deployer@dinner-and-groceries.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=dinner-and-groceries
```

> The runtime (default compute) SA's `secretAccessor` grant from **P1 step 1.6** stays as-is;
> it is harmless but no longer load-bearing for `NEXT_PUBLIC_*` (nothing binds them at
> runtime now). Only the **anon** URL + key are ever accessed — never the service-role key.

### 3.2 The deploy mechanism (build-time inlining, no runtime secret binding)

Next.js inlines `NEXT_PUBLIC_*` into the browser bundle at **build time**, so a Cloud Run
runtime secret binding is too late (`lib/supabase/env.ts` throws when the sign-in page's
browser client loads). The `deploy` job therefore:

1. authenticates as the deploy SA via WIF (no key);
2. `gcloud secrets versions access latest` for both `NEXT_PUBLIC_*` secrets → `$GITHUB_ENV`;
3. passes them to `docker build` as `--build-arg`s (the `Dockerfile` builder stage declares
   matching `ARG`/`ENV` so `next build` inlines them);
4. pushes to Artifact Registry and deploys with
   `--allow-unauthenticated --min-instances=0` (ADR 0009);
5. binds **no** `NEXT_PUBLIC_*` runtime secrets (they are build-time only).

See `docs/ci.md` for the full flow.

### 3.3 First deploy

Setting `GCP_PROJECT_ID` (P0 step 0.7) flips the gate on; the next merge to `main` runs the
real deploy and produces `<RUN_APP_URL>` (read it via P2 step 2.3). **Merging to `main` is
the human owner's call** — it triggers a real production deploy.

**P3 done when:** the deploy SA holds `secretAccessor` on both secrets, a merge to `main`
builds + pushes an image and deploys the `dinner-and-groceries` Cloud Run service
(`--allow-unauthenticated`, `--min-instances 0`), and the `run.app` URL loads to the sign-in
screen.

---

## Order of operations (across P0/P1/P2/P3)

1. **P0** (GCP + WIF + repo vars) and **P1 steps 1.1–1.6** (Supabase project, migrations,
   secrets) — independent, do both.
2. **P2 steps 2.1–2.2** (OAuth client + redirect URI; needs only `<project-ref>`).
3. **P3 step 3.1** (grant the deploy SA `secretAccessor` on both secrets), then setting
   `GCP_PROJECT_ID` flips the gate → **P3 first deploy** → `<RUN_APP_URL>`.
4. **P2 steps 2.4–2.5** (JS origin, Site URL, test users) → sign-in works.
5. **P1 step 1.7** two-user smoke, then **P4 (#54)** the Realtime-on-cloud gate.
