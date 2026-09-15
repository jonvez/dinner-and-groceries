# Runbook — production database migrations (automated)

How schema changes reach cloud Supabase prod now that the pipeline applies them. Decision of
record: **ADR 0015**. This supersedes the manual `npx supabase db push` for *ongoing* changes;
`production-bringup.md` § P1.2–1.3 stays as the original bring-up record.

- **Who runs what:** § 1 (one-time credential setup) and § 2 (rotation) are **Jon only** — they
  touch a real credential. § 3 (failure playbook) is whoever is on the red run; every command in
  it is safe to read first with `--dry-run` or `migration list`.
- **Every block below states its own preconditions** (directory, branch, binary). There is no
  global `supabase` binary in this project — it is a devDependency pinned at **2.107.0** (#164),
  so every invocation is `npx supabase` **from the repo root**.

---

## 0. How it works, in one paragraph

On every push to `main`, after `verify` + `rls` + `e2e` pass, the `migrate` job authenticates to
GCP with keyless Workload Identity Federation (the existing deploy identity), reads the secret
`SUPABASE_MIGRATION_DB_URL` from GCP Secret Manager, and runs `npx supabase db push --db-url …
--yes`. If it fails, `deploy` does not run — prod keeps the old code *and* the old schema. If it
succeeds, the Cloud Run deploy follows. Each migration file is applied in its own transaction, and
re-running is safe: only still-pending files are applied.

---

## 1. One-time setup (Jon)

### 1.1 Get a database password for the prod project

Supabase dashboard → project **`dinner-and-groceries`** (ref `wcbjuobzeursmomcoefw`) →
**Project Settings → Database → Database password → Reset database password**.

The password cannot be read back after creation, so reset it and capture the new one. Use an
**alphanumeric-only** password — the CLI requires the connection URI to be percent-encoded, and
alphanumeric sidesteps the whole problem:

```
openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 40
```

Store it in your password manager. (Rehearsed: produces a 40-character A–Za–z0–9 string.)

> Resetting invalidates the password cached by your local `supabase link`. If you later want to
> run a manual push, re-link with `cd /Users/jonathangill/dev/dinner-and-groceries && npx supabase
> link --project-ref wcbjuobzeursmomcoefw -p '<password>'`. `npx supabase db query --linked` is
> unaffected — it rides the `supabase login` token, not the password.

### 1.2 Build the connection URI

The **session pooler** (port **5432**) — *not* the transaction pooler (6543), which cannot run DDL.
This project's exact pooler host and user are already known from its own link state
(`supabase/.temp/pooler-url`):

```
postgresql://postgres.wcbjuobzeursmomcoefw:<PASSWORD>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres
```

Sanity-check it against the dashboard before using it — **Project Settings → Database →
Connection string → Session pooler (URI)** should show the same host, user and port, with
`[YOUR-PASSWORD]` where the password goes. If the host differs, trust the dashboard.

### 1.3 Verify the credential *before* CI ever uses it

Read-only, applies nothing, and proves the URI is well-formed and the pooler reachable:

```
cd /Users/jonathangill/dev/dinner-and-groceries
git checkout main && git pull
printf 'Paste the connection URI: '; read -rs MIGRATION_DB_URL; echo
npx supabase migration list --db-url "$MIGRATION_DB_URL"
```

Expect the aligned `Local | Remote` table with a row per migration and **no blank cells**. A blank
**Local** cell means prod has a version the repo does not (see § 3.1); a blank **Remote** cell
means a migration has not been applied yet (normal if you are mid-flight, otherwise § 3.2).

`read -rs` keeps the URI out of your shell history and off the screen. Keep this shell open for
the next two steps.

### 1.4 Create the Secret Manager secret

```
printf '%s' "$MIGRATION_DB_URL" | gcloud secrets create SUPABASE_MIGRATION_DB_URL --data-file=- --replication-policy=automatic --project=dinner-and-groceries
```

`printf '%s'` (not `echo`) — a trailing newline would corrupt the URI.

### 1.5 Grant read access to the **deploy SA only**

```
gcloud secrets add-iam-policy-binding SUPABASE_MIGRATION_DB_URL --member="serviceAccount:deployer@dinner-and-groceries.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=dinner-and-groceries
```

**Do not** grant this to the Cloud Run runtime compute SA. The running app must never be able to
read a credential that bypasses RLS (ADR 0015 § 8, ADR 0003).

Then clear the value from the shell:

```
unset MIGRATION_DB_URL
```

### 1.6 Confirm the grant is exactly one principal

```
gcloud secrets get-iam-policy SUPABASE_MIGRATION_DB_URL --project=dinner-and-groceries
```

Expect a single `roles/secretmanager.secretAccessor` binding for
`serviceAccount:deployer@dinner-and-groceries.iam.gserviceaccount.com`. Anything else — in
particular `…-compute@developer.gserviceaccount.com` — must be removed.

**Setup done when:** the secret exists, `get-iam-policy` shows only the deploy SA, `migration list`
worked from Jon's machine, and no copy of the URI exists in GitHub secrets, `.env*`, or any file in
the repo.

---

## 2. Rotation (Jon)

No repo or workflow change is needed — the job reads `:latest`.

```
# 1) Supabase dashboard → Project Settings → Database → Reset database password (§ 1.1)
# 2) rebuild the URI (§ 1.2) and add it as a NEW version:
printf 'Paste the new connection URI: '; read -rs MIGRATION_DB_URL; echo
printf '%s' "$MIGRATION_DB_URL" | gcloud secrets versions add SUPABASE_MIGRATION_DB_URL --data-file=- --project=dinner-and-groceries
unset MIGRATION_DB_URL
```

Rotate immediately if the value was ever pasted into a chat, a log, a terminal that gets shared,
or a GitHub secret. Old versions can be disabled with
`gcloud secrets versions disable <N> --secret=SUPABASE_MIGRATION_DB_URL --project=dinner-and-groceries`.

---

## 3. When `migrate` goes red

`deploy` is skipped whenever `migrate` fails, so a red `migrate` means **prod is running the
previous image against the previous schema** — consistent, but the merge is not live. Nothing is
half-applied inside a file: each migration file runs in its own transaction.

Start by reading the job log. The first `migration list` step prints prod's state *before*
anything was attempted; that is usually the whole diagnosis.

### 3.1 `Remote migration versions not found in local migrations directory`

Prod has a migration version the repo does not — someone hand-applied SQL, or applied a migration
from a branch that never merged. **The pipeline is wedged for every subsequent deploy until this is
fixed.** Two legitimate fixes:

- **The change belongs in the repo** (it was applied from a branch that is still open): merge that
  branch. The version then exists locally and the next run is green.
- **The change should never have been applied** (abandoned branch, experiment): mark it reverted in
  prod's history, which only edits the history table, not the schema:

  ```
  cd /Users/jonathangill/dev/dinner-and-groceries
  git checkout main && git pull
  printf 'Paste the connection URI: '; read -rs MIGRATION_DB_URL; echo
  npx supabase migration repair --status reverted <VERSION> --db-url "$MIGRATION_DB_URL"
  npx supabase migration list --db-url "$MIGRATION_DB_URL"
  unset MIGRATION_DB_URL
  ```

  **`repair` does not undo the DDL.** If the abandoned change actually altered the schema, write a
  forward migration that removes it and let the pipeline apply that.

Re-run the failed workflow run from the Actions tab once resolved.

### 3.2 `Found local migration files to be inserted before the last migration on remote database`

Two branches each added a migration and they merged out of timestamp order, so a file older than
prod's history head is pending. It is a **human decision**, not an automatic `--include-all`: the
older file was written against an older schema, and applying it after a newer one may not be
equivalent.

- **Preferred:** rename the stray file to a timestamp later than prod's head (it has not been
  applied anywhere but local/CI databases, so renaming is safe), push the fix, let the pipeline run
  normally. `npx supabase db reset --local` afterwards to keep local in step.
- **Only if the ordering genuinely does not matter,** and after reading both files, a maintainer may
  apply it by hand with `--include-all` and note why on the PR. The workflow itself must never pass
  `--include-all`.

### 3.3 The migration SQL itself failed (`ERROR: … (SQLSTATE …)`)

The failing file rolled back completely; files before it are applied and recorded. **Fix forward,
never edit an applied migration** (verified: the CLI silently ignores edits to files already in the
history table — an edited applied migration is invisible drift).

1. Reproduce locally: `cd /Users/jonathangill/dev/dinner-and-groceries && npm run db:start && npx supabase db reset --local`.
2. Fix the file **if it is still pending in prod** (it is — it rolled back), open a PR, merge. The
   next run applies it.
3. If earlier files in the same push did apply and the app is now on a partially-expanded schema,
   that is safe under the expand-only rule in ADR 0015 § 3 — the old container is still serving.
4. `npm run db:stop` when done (the local stack is eleven containers and nothing reaps it).

### 3.4 Connection refused / timeout

Most likely the **Free-tier project has paused** (~7 days idle — ADR 0010). Open the Supabase
dashboard, un-pause the project, then re-run the workflow run. A paused project blocking deploys is
intended: there is no point shipping an app whose database is asleep.

Also possible: a pooler incident (status.supabase.com). `migrate` does not auto-retry `db push` on
purpose — a human re-run is a deliberate act.

### 3.5 The run was cancelled mid-apply

Should not happen after ADR 0015 § 4 (main-branch runs queue instead of cancelling, and `migrate`
holds a `prod-migrate` concurrency group). If it does: nothing is half-applied inside a file, and
`db push` resumes from the history table. Re-run the run and read the pre-flight `migration list`
to confirm where it stopped.

### 3.6 Nobody noticed the red run

A push-to-`main` job can never be a required check, so the only signals are GitHub's failure
notification and the board. If a red `migrate` or `deploy` has been sitting, treat it the same way
as the 2026-08-12 incident: prod is stale until proven otherwise. Check with

```
cd /Users/jonathangill/dev/dinner-and-groceries && git checkout main && git pull
printf 'Paste the connection URI: '; read -rs MIGRATION_DB_URL; echo
npx supabase migration list --db-url "$MIGRATION_DB_URL"
unset MIGRATION_DB_URL
```

or, without any credential at all (rides the `supabase login` token):

```
cd /Users/jonathangill/dev/dinner-and-groceries && npx supabase db query --linked "select version from supabase_migrations.schema_migrations order by version desc limit 5;"
```

---

## 4. Rules that keep this working

- **Applied migrations are immutable.** Fix forward. The CLI will not notice an edit, and CI cannot
  protect you from it.
- **Migrations merged to `main` must be backward compatible with the deployed app** (ADR 0015 § 3).
  A narrowing change (drop/rename a column, tighten an RLS policy the live app relies on) ships as
  two PRs: the app stops depending on it and deploys, *then* the contraction merges.
- **Never hand-apply to prod without the file also landing on `main`** — remote-ahead drift wedges
  the pipeline for everyone.
- **Never use the transaction pooler (port 6543)** for migrations, and never pass `--debug` in the
  `migrate` job (it prints the connection string).
- **No statements that cannot run inside a transaction** (`CREATE INDEX CONCURRENTLY`, `VACUUM`).
  The CLI wraps each file in one; such a statement will fail the file. If one is ever genuinely
  needed, it is a documented manual exception, not a pipeline change.
- Consider opening each migration with `set local lock_timeout = '5s';` so a DDL statement queues
  behind a long-running query for five seconds rather than blocking the whole database.
