# ADR 0015 — Deploys apply prod migrations: `db push` over a pooler URI held in Secret Manager, before the app deploy

- **Status:** Accepted
- **Date:** 2026-09-15
- **Decided by:** **Jon** chose to *automate* (#68 option 2, prioritized ahead of #17, 2026-09-15).
  The **mechanism** below is the Architect's, inside the ADR 0009 / 0010 guardrails.
- **Relates to:** #68 (this issue), ADR 0009 (keyless WIF / Cloud Run topology), ADR 0010
  (cloud Supabase as prod — "`db push` is a privileged operation Jon runs manually; not in CI"),
  ADR 0011 (Realtime cloud gate), ADR 0003 (RLS is the security boundary; no service-role in app
  paths), ADR 0014 (#17's owner-only `events_select` — the first migration through this path),
  #164 (the CLI pin at 2.107.0), #17, #64, #210.
  Retro entries: 2026-08-12 ("migrations never auto-reach cloud prod"), 2026-08-26 ("I declared prod
  writes blocked without checking the tool surface"), 2026-09-10 ("I handed over commands nobody
  could run"), 2026-09-15 ("two issues, two migrations, and #68 still isn't done").
  Runbook: `docs/runbooks/prod-migrations.md` (new). Supersedes the manual push in
  `docs/runbooks/production-bringup.md` § P1.2–1.3 for *ongoing* changes (that section stays as the
  bring-up record).

## Context

Merging a migration PR redeploys the Cloud Run **app** but changes nothing in the **cloud Supabase**
schema. CI applies migrations only to an ephemeral CI Postgres (`supabase db reset --local`) for
pgTAP/E2E. Prod schema moves only when a human runs `npx supabase db push` by hand, from the feature
branch, before merging. That gap has produced real damage, repeatedly:

- #63 shipped green and stayed broken in prod until someone remembered the push.
- The 2026-08-12 retro found "merged to main ≠ in production" for weeks of merges.
- By 2026-09-15 the *cost* had started distorting design: #64's migration was deliberately widened to
  cover `slot_dishes` purely to save one manual apply. Grooming decisions were being made to dodge a
  missing pipeline step.

Jon prioritized automating it ahead of #17, whose owner-only `events_select` migration (ADR 0014) will
be the first change through the automated path.

The design constraints that actually bind:

1. **ADR 0009 removed every long-lived credential from GitHub.** CI authenticates to GCP with
   short-lived, repo-pinned OIDC; no JSON keys. Any credential this ADR introduces has to be argued
   against that posture, not smuggled past it.
2. **The CLI is pinned at 2.107.0** (#164 — 2.116.0 breaks local role isolation and five pgTAP
   guards). Whatever we use must work on 2.107.0, invoked as `npx supabase` from the repo root
   (there is no global binary).
3. **`main` deploys on every push, and runs cancel each other** (`cancel-in-progress: true`).
4. There is **no staging tier** (ADR 0010, and the 2026-08-12 retro raised it). Every applied
   migration lands on the database that holds real family data.

### What the pinned CLI actually does (verified, 2026-09-15, CLI 2.107.0)

Every claim below was executed locally against a throwaway `postgres:15` container and/or the local
stack — never against prod. Commands and output are in the #68 architecture report.

| Behaviour | Verified result |
|---|---|
| `db push --db-url <uri>` | Works. No `supabase link`, no `SUPABASE_ACCESS_TOKEN`, no keyring. |
| `db push --yes` | Suppresses the "Do you want to push these migrations?" confirm. **Without it the job can hang on a prompt.** |
| Remote connections | **TLS is mandatory** — a non-TLS remote host is refused outright (`tls error (server refused TLS connection)`), even with `sslmode=disable`. |
| Atomicity | **Per migration file.** A file failing on its 2nd statement left its 1st statement rolled back and no history row. |
| Resumability | Re-running after a failure applies only the still-pending files, exit 0. Idempotent at the set level. |
| Up-to-date run | `Local database is up to date.`, exit 0 — a cheap no-op. |
| Remote-ahead drift (a hand-applied version missing from the repo) | **exit 1**, `Remote migration versions not found in local migrations directory`, with `migration repair` guidance. Fail-closed. |
| Out-of-order file (timestamp older than the remote head — the two-developer merge race) | **exit 1**, `Found local migration files to be inserted before the last migration on remote database`, suggests `--include-all`. Fail-closed. |
| **Edited already-applied file** | **Silently ignored.** No checksum, no warning, no error. The one drift class the CLI cannot see. |
| `migration list --db-url <uri>` | Works non-interactively; prints aligned `Local \| Remote` columns, a blank cell on either side being the drift signature. **Always exits 0** — a wrapper must parse it. `--output-format json` is *not* honoured here (still prints the text table). |
| Management API migrations endpoints (`/v1/projects/{ref}/database/migrations`) | Present in the CLI's API surface but documented **"Only available to selected partner OAuth apps"** — not reachable with a personal access token. |
| `db query --linked` | Genuinely Management-API-transported (no DB password) — but it is *query*, not *migrate*: it does not read `supabase/migrations/`, does not maintain `supabase_migrations.schema_migrations`, and does not order or gate anything. |

## Decision

### 1. A `migrate` job in `.github/workflows/ci.yml`, running `db push` over a **session-pooler URI**

The credential is **one secret**: the full percent-encoded Postgres **session-pooler** connection URI
for the prod project (`…@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`, port **5432** =
session mode, which DDL and transactions require; port 6543 transaction mode must **not** be used).

It is stored **only in GCP Secret Manager**, as `SUPABASE_MIGRATION_DB_URL`, read at job time by the
**existing keyless WIF deploy identity** — the same mechanism, same SA, same gate
(`vars.GCP_PROJECT_ID`) the deploy job already uses for `NEXT_PUBLIC_*`.

```
npx supabase migration list --db-url "$SUPABASE_MIGRATION_DB_URL"   # pre-flight: log prod's state
npx supabase db push        --db-url "$SUPABASE_MIGRATION_DB_URL" --yes
npx supabase migration list --db-url "$SUPABASE_MIGRATION_DB_URL"   # post-flight: assert, parsed
```

`--include-all` is **never** passed. `--debug` is **never** passed (it prints the connection string).

**Why not the other three candidates:** see *Alternatives considered*. The short version: this is the
only option that needs **no** `SUPABASE_ACCESS_TOKEN`, and a PAT is a strictly larger credential than
a single database's password — it reaches every project in Jon's Supabase account, can rotate the
service-role key, and can run arbitrary SQL through the Management API.

### 2. **No long-lived secret enters GitHub.** ADR 0009's invariant is preserved, deliberately

GitHub gets nothing durable: the job mints a short-lived, repo-pinned OIDC token, exchanges it for
deploy-SA credentials, and reads the URI from Secret Manager. That keeps ADR 0009 literally true
("no long-lived credential is stored in GitHub"), makes every read of the credential appear in GCP
audit logs, and makes rotation a Supabase password reset plus one `gcloud secrets versions add` —
no repo change, no workflow edit, `:latest` picks it up.

A GitHub Actions secret was the obvious cheaper alternative and is **rejected**: it would reintroduce
exactly the class of artifact ADR 0009 exists to eliminate, in the one place ADR 0009 cleared out.

### 2a. Jon's confirmations (2026-09-15)

The three trades this ADR could not decide on its own were put to Jon explicitly, and he confirmed all
three:

1. **A prod DB credential may exist at rest.** He accepts that `SUPABASE_MIGRATION_DB_URL` lives in GCP
   Secret Manager, readable by the deploy SA only, and that if it leaked it grants full DDL/DML on the
   prod database with RLS bypassed — every household's data. This is a real reduction in posture versus
   having no such credential anywhere, accepted knowingly as the price of automating, and preferred over
   the account-wide PAT alternative (which additionally permits API-key rotation, auth-config changes and
   project deletion). It remains consistent with ADR 0003: the service-role ban is about *app paths*, and
   this credential is never in the app, never in the image, and never bound to Cloud Run.
2. **Drift stays fail-closed** (§6): detected drift fails the job and therefore blocks the deploy —
   including unrelated, docs-only merges — until a human repairs the history. He chose loudly broken over
   silently diverged, with the `migration repair` procedure in the runbook as the fix.
3. **His one-time setup happens before #68's PR merges**, so #17's owner-only `events_select` migration
   is genuinely the first change to reach prod through the automated path, rather than needing one more
   manual apply.

### 3. Migrations run **before** the app deploy, and migrations must be backward-compatible

`deploy` gains `needs: migrate`; `migrate` gains `needs: [verify, rls, e2e]`.

- **Migrate-first** is right for an *expanding* (additive) migration: the old container keeps working
  against the new schema, and the new container never meets the old schema. "New code, old schema" is
  the failure that has actually bitten this project (#63, `/grocery` 500s); migrate-first makes it
  impossible.
- **`migrate` fails ⇒ `deploy` never runs.** Prod keeps old code on old schema — coherent, nothing
  half-shipped. This is the main reason the order is migrate-then-deploy rather than the reverse.
- **`migrate` succeeds, `deploy` fails ⇒ old code on new schema.** Harmless *provided* the migration
  was expanding. The red run is the signal; per the existing posture, a red deploy means stale prod
  and is not allowed to sit.
- **Therefore a repo rule, not just a hope:** *a migration merged to `main` must be backward
  compatible with the currently deployed app.* Narrowing changes (drop/rename a column, tighten an
  RLS policy that the live app depends on) ship as **two PRs**: first the app stops depending on the
  thing and deploys, then the contracting migration merges. This rule is the price of migrate-first
  and of having no staging tier; it goes in `docs/ci.md` and the migration authoring notes.
- **#17 is safe under this rule** even though it *tightens* `events_select`: nothing in the deployed
  app reads `events` yet (ADR 0014 § Consequences says so explicitly). That must be stated on #17
  rather than rediscovered.
- `rls` joins `migrate`'s `needs` deliberately: **no migration reaches prod whose pgTAP allow/deny
  suite did not pass on this exact commit.** Required checks gate *merges*; this gates *application*.

### 4. Main-branch runs must stop cancelling each other

`cancel-in-progress: true` currently applies to `main` pushes too, so two quick merges can kill a run
mid-apply. Cancellation during `db push` is survivable (per-file atomicity + resumability, verified
above) but it is not something to design in. Two changes:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}   # PRs still cancel; main queues
```
plus a job-level guard on `migrate` so prod applies serialize regardless of trigger:
```yaml
    concurrency:
      group: prod-migrate
      cancel-in-progress: false
```

### 5. No environment approval gate — for now

A GitHub Environment with a required reviewer *is* available here (unlike required PR review, which a
single GitHub identity makes unsatisfiable — self-approval of a deployment is permitted), but adding
it would make every merge wait on a human click, which is the manual step Jon just voted to delete.
The expand-only rule in §3 plus fail-closed drift in §6 carry the safety instead. Recorded as the
**one-setting escape hatch** if a genuinely destructive migration is ever needed, or if the app gains
users outside the household.

### 6. Drift is **fail-closed**, and one drift class is undetectable

`db push` itself is the drift gate: remote-ahead and out-of-order both exit 1 (verified). A post-flight
`migration list` parse asserts every local version is present remotely, so "the job went green"
means "the repo's migration history is prod's migration history". A drift failure **blocks the
deploy**, including for unrelated merges, until a human repairs it. That is the intended trade: loud
and inconvenient beats silent divergence, which is the thing this ADR exists to kill.

Two honest limits:

- **An edited already-applied migration file is invisible** (verified: silently ignored, no checksum).
  Mitigation is process, not pipeline: applied migrations are immutable; fix forward with a new file.
- **`migration list` compares history, not schema.** A change made in the Supabase dashboard SQL
  editor that never touches `supabase_migrations.schema_migrations` will not be noticed. Real schema
  diffing (`db diff --linked`) needs Docker plus a password in CI and is rejected as scope here; the
  compensating controls are pgTAP-in-CI (the standing RLS guard, ADR 0010) and the runbook's FORCE-RLS
  / publication assertions. A scheduled invariant check is a named follow-up.

### 7. The job always runs on `main` pushes — no path filter

`db push` with nothing pending is a sub-second no-op (`Local database is up to date.`, exit 0), so the
whole job is dominated by checkout + `npm ci`. Running it unconditionally means (a) no path-filter bug
can ever silently skip a real migration — the failure mode here fails *open*, which is unacceptable —
and (b) every merge becomes a standing assertion that prod's migration history matches the repo.
The docs-only fast-path (#99) is not extended to it.

### 8. Security requirements (Definition of Done additions for #68)

- `SUPABASE_MIGRATION_DB_URL` exists **only** in GCP Secret Manager. Not in GitHub secrets, not in
  `.env*`, not in the image, **not bound to Cloud Run**, never printed.
- `roles/secretmanager.secretAccessor` on it is granted to the **deploy SA only**. The Cloud Run
  **runtime** compute SA must **not** be granted it — the running app has no business holding a
  credential that bypasses RLS.
- The value is masked (`::add-mask::`) before it can reach any log; `--debug` is banned in this job.
- The job runs on `push` to `main` only — never on `pull_request`, so no PR (least of all a fork's)
  can reach the credential. Workflow permissions stay `contents: read` + `id-token: write`.
- A **non-author `security-review`** (TEAM.md gate) covers this PR: credential handling, log masking,
  the IAM grant's scope, and that no new GitHub secret was created.
- Prod schema state after the first real migration is **verified independently**, not inferred from a
  green job (the 2026-08-26 lesson).

## Consequences

**Positive**
- "Merged" means "applied". The footgun PLAN.md warns about, that #63 hit and that #64's grooming
  bent around, is gone. Migration cost stops leaking into scope decisions.
- Prod can no longer be silently ahead of the repo: history drift stops the pipeline.
- ADR 0009's keyless-GitHub posture survives intact; the new credential is auditable, versioned and
  rotatable without touching the repo.
- The migrate job is cheap and Docker-free (`npm ci` + three CLI calls), and needs no new tooling,
  no new action, and no CLI bump (#164's pin holds).
- `migrate`'s `needs: rls` makes "RLS tested before the schema moves" a pipeline property.

**Negative / residual risk**
- **A high-privilege credential now exists at rest.** If `SUPABASE_MIGRATION_DB_URL` leaks, the holder
  has full DDL/DML on the prod database and bypasses RLS entirely — every household's data. It cannot
  touch other Supabase projects, rotate API keys, change auth config, delete the project, or reach
  GCP. Minimized per §8; rotation is documented. This is a genuine reduction in posture versus
  "no prod DB credential exists anywhere in CI", and it is the cost of Jon's choice to automate.
  It is *not* the service-role ban being relaxed: ADR 0003 bans service-role **in app paths**
  (reachable from the request path, forever, from anywhere). This credential is never in the app.
- **Drift fail-closed blocks unrelated deploys.** A hand-applied version that never merges (an
  abandoned PR) wedges every subsequent deploy until `migration repair` runs. Documented with a
  two-minute recovery.
- **Out-of-order merges will red the pipeline** on a two-developer team (verified exit 1). The cheap
  preventative is a PR-time monotonic-timestamp check (§ Follow-ups / part of #68's scope).
- **Free-tier pausing (ADR 0010) now blocks deploys**: a paused project fails the connection, so
  `migrate` reds and `deploy` is skipped. Arguably correct, and the recovery is un-pause + re-run.
- **An edited applied migration, and any dashboard-made schema change, remain undetected** (§6).
- Rotating the DB password invalidates the password cached in Jon's local `supabase/.temp/pooler-url`;
  he re-runs `npx supabase link --project-ref … -p <new>` for manual pushes. `db query --linked` is
  unaffected (it rides the login token).
- `ci.yml` grows past ~400 lines. If it keeps growing, extract `migrate` + `deploy` into a
  `deploy.yml` — but not now: a separate workflow loses the direct `needs:` chain to
  `verify`/`rls`/`e2e` and would have to be rebuilt on `workflow_run`, which is strictly worse for
  the property that matters most (tests gate the schema change).

**Alternatives considered**

- ***`SUPABASE_ACCESS_TOKEN` + `supabase link --project-ref` in CI.*** The canonical Supabase CI
  recipe. **Rejected:** a PAT is account-wide — every project, API-key rotation (including
  service-role), auth config, project deletion, arbitrary SQL via the Management API. Strictly larger
  blast radius than one database's password, for no gain: `link` would still need
  `SUPABASE_DB_PASSWORD` for `db push` anyway (verified: the CLI's connection path requires a password
  on both the direct and pooler routes), so this option costs *two* secrets instead of one.
- ***`db push` with a bare `SUPABASE_DB_PASSWORD` and `--linked`.*** Needs the link state, which needs
  the PAT (above), and leaves the direct-vs-pooler host choice to the CLI's reachability probe
  (`db.<ref>.supabase.co` is IPv6-only on new projects; GitHub runners have no IPv6). **Rejected** in
  favour of an explicit URI: one secret, deterministic transport, nothing to probe.
- ***Applying migration SQL through the Management API (`db query --linked` transport, or the
  `/database/migrations` endpoints).*** Attractive because it needs no DB password. **Rejected on
  both halves:** the `/database/migrations` endpoints are restricted to "selected partner OAuth apps"
  and are unreachable with a PAT (verified in the CLI's API surface); and `db query` is a query tool —
  using it would mean hand-rolling migration ordering, the `schema_migrations` history table, pending
  detection and drift comparison, i.e. reimplementing `db push` badly against a Beta endpoint, while
  *still* needing a PAT. It stays what it is: the right tool for an agent-run one-off prod read/write.
- ***A GitHub Actions secret instead of Secret Manager.*** Simpler (one `gh secret set`), and fork PRs
  can't read it. **Rejected:** it puts a durable, high-value secret back into GitHub — the exact
  artifact ADR 0009 removed — readable by any workflow change on `main`, with no audit trail on read.
- ***A dedicated least-privilege `migrator` Postgres role.*** **Rejected as security theatre for now:**
  to run this project's migrations it would need to own (or be granted over) every table, policy and
  function in `public`, which is not meaningfully weaker than `postgres`. Revisit only if migrations
  ever stop touching everything.
- ***Deploy first, migrate second.*** **Rejected:** it guarantees a window of new code on old schema,
  which is the exact failure this project has already shipped twice.
- ***Required environment approval on every deploy.*** **Rejected:** reinstates the manual step (§5).
- ***Document the manual step instead (#68 option 1).*** Jon's explicit call was option 2. The record
  supports it: the manual step has been documented since ADR 0010 and was still missed, and by
  2026-09-15 its cost was warping grooming.

## Follow-ups

- **PR-time monotonic-migration check** (in `verify`, no credentials): assert every file added under
  `supabase/migrations/` relative to the merge base sorts after every pre-existing file. Prevents the
  most likely `migrate` red. In scope for #68 (see its ACs).
- **Scheduled prod invariant check** — extend `audit.yml` (or a sibling cron) to assert prod's
  standing invariants via `migration list` plus a read-only `db query`: FORCE RLS on every
  household-scoped table, `reactions`/`comments` in `supabase_realtime`, no `MAINTAIN`/broad grants to
  `anon`/`authenticated` (the #140 leak class). This is the answer to "who notices a red main run
  nobody watched" and to dashboard-made drift. **File as a new issue**, not part of #68.
- **`prod-build` is not in `deploy`'s `needs`** — the deploy job rebuilds the image itself, so a
  broken image reds the deploy rather than shipping. Noted in passing; no change proposed.
- Staging tier (2026-08-12 retro, still open) would remove the "no rehearsal before prod" residual
  risk in §3 and §6 wholesale. Out of scope for M1.
- `docs/runbooks/production-bringup.md` § P3.2 describes the deploy as binding **no** runtime
  `NEXT_PUBLIC_*` secrets, while `ci.yml` does bind them (and PLAN.md says both are required). Doc
  drift, unrelated to this ADR; worth a one-line fix in whichever PR next touches the runbook.
