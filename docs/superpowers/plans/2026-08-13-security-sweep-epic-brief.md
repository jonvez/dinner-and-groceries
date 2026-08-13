# Kickoff Brief — Security & Hardening Sweep (Epic #122)

**Date:** 2026-08-13 · **Model:** epic-run (Gate 1 → autonomous Gate 2 → acceptance Gate 3)
**Board:** epic #122 with 4 nested sub-issue stories.

## Goal (user terms)

Clear the accumulated security/hardening backlog in one autonomous sweep: get the dependency audit
to zero, close two defense-in-depth gaps (DB grants, URL-normalization), and de-flake the CI stack
so the unattended runs don't burn re-runs — leaving the app's security posture clean before the
mobile/productizing work.

## Acceptance criteria (done means…)

- **AC-1:** `npm audit` on `main` reports **0 vulnerabilities**.
- **AC-2:** The `authenticated`/`anon` roles can no longer `TRUNCATE` (or `REFERENCES`/`TRIGGER`)
  public tables; a pgTAP test asserts the revoke and that legitimate `SELECT`/`INSERT` still work.
- **AC-3:** `safeHttpUrl` returns the normalized `parsed.href`; all callers still behave; the
  "validated string ≠ stored string" class is gone, proven by updated unit tests.
- **AC-4:** The Supabase-stack boot in the pgTAP + E2E jobs no longer hard-fails on a Docker Hub
  rate-limit (retry/backoff, optionally cached) — a transient pull error self-recovers in-run.
- **AC-5:** Every merged PR is green on all four required checks (Lint/typecheck/unit, Playwright
  smoke E2E, RLS pgTAP, Production build Docker). Member issues #98, #113, #19, #49, #93 closed.
- **AC-6 (posture):** No service-role key in app paths; RLS `enable`+`force` unchanged (ADR 0003).

## Threat model (one pass → which stories get a security gate)

| Story | Surface touched | Security gate? |
|---|---|---|
| **D — CI de-flake (#98)** | CI workflow only; no app code, no secret in the chosen scope | **No** — config-only |
| **A — Deps bump (#113/#19)** | Dependency versions; risk is *regression*, not new attack surface | **No** — verified by audit-clean + full regression gates (Prod-build/E2E/smoke) |
| **B — Revoke grants (#49)** | Postgres GRANT/REVOKE on public tables — RLS-adjacent authz | **Yes** — non-author review that the revoke is correct and doesn't break legit access |
| **C — safeHttpUrl (#93)** | Shared SSRF/XSS-guard primitive used app-wide (board `source_url`, recipe URLs) | **Yes** — non-author review that SSRF/normalization protection doesn't regress |

## Decomposition, sequence & dependencies

Stories are mutually independent (different files) → could parallelize, but run **serial** in this
order so each auto-merge rebases cleanly and the risky Next bump lands against a de-flaked CI:

1. **Story D (#98) — first.** Minimal no-secret de-flake: retry/backoff on the `supabase start`
   steps in the pgTAP + E2E jobs (optionally an image cache). **Deliberately NOT the Docker Hub
   auth option** — that needs a Docker Hub token only Jon can create, which would break autonomy.
   If retry/cache proves insufficient later, token-auth is a follow-up (needs Jon).
   Files: `.github/workflows/ci.yml`.
2. **Story A (#113, closes #19) — highest risk.** Bump `next` 15.5.19 → 15.5.23 and
   `@tailwindcss/postcss` → 4.3.3 in `package.json` + `package-lock.json` (approved: raise the pin).
   Re-run audit → 0 vulns; the vendored-postcss advisory (#19) clears with the Next bump. The
   Production build (Docker) + E2E + smoke gates are the regression net. Part A of #113
   (brace-expansion/js-yaml/undici) already landed in PR #117.
3. **Story B (#49).** Migration revoking `TRUNCATE, REFERENCES, TRIGGER` from `anon`/`authenticated`
   on public tables (belt-and-suspenders: also set as a default for future tables where sensible);
   pgTAP asserting the revoke + that `authenticated` retains needed `SELECT`/`INSERT`.
   Files: new `supabase/migrations/*.sql`, new/updated `supabase/tests/*.sql`.
4. **Story C (#93).** `lib/web/safe-url.ts` returns `parsed.href`; update `lib/web/safe-url.test.ts`;
   verify every caller (board `source_url`, recipe source/image URLs) tolerates the normalized form.

## Cross-story architecture decisions (resolved once)

- **Next bump is a patch-within-15.5.x** — deliberately raise the stated pin (Jon approved). Not a
  major/minor upgrade; no App-Router API migration expected. If `next build` or E2E regresses, that
  is a BLOCKED escalation, not a silent pin-loosen.
- **Story B revoke must not touch RLS policies or the SECURITY DEFINER helper** — it operates only on
  table-level GRANTs. `authenticated` keeps `SELECT`/`INSERT` (and `UPDATE`/`DELETE` where the app
  uses them); only `TRUNCATE`/`REFERENCES`/`TRIGGER` are revoked. RLS remains the real boundary.
- **Story C normalization is behavior-preserving for valid URLs** — `parsed.href` only changes
  trailing-slash/host-case/percent-encoding; any caller that stored raw and compares by equality is
  the risk to check. No SSRF allowlist logic changes.

## Autonomy boundary

- **Auto-merge (low prod-risk):** all four stories. None touch auth, live-data migration of existing
  rows, or cross-tenant exposure. Story B adds a *new* migration (grants only — no data change);
  merging it does **not** alter prod until a manual `supabase db push` (the known footgun) — so the
  merge itself is safe, and applying it to cloud is a separate, deliberate Jon step noted at Gate 3.
- **Escalate (needs a human beat):** Story A if the Next bump regresses build/E2E; Story D if the
  no-secret mitigation can't stop the flake (→ token-auth needs Jon); any finding in B/C that turns
  out to be a real posture decision rather than a bug.

## Cost

No clean `/cost` baseline (session is contaminated by firm-up + upcoming retro; `/cost` is
session-scoped). Cost via the **dispatch-count proxy**: 4 stories, ~2 gated dispatches each (dev +
review, +security for B/C) ≈ **10–12 dispatches**, ≈ **200k output tokens/story-with-gates**. Logged
to the Build-Team Epic Cost Log at acceptance.

## Gate 3 preview (acceptance)

Merged epic checked against AC-1…AC-6 + one integration pass: `npm audit` clean, pgTAP green
(incl. the new revoke test), safe-url tests green, a CI run showing the stack-boot retry works.
Reminder at acceptance: **Story B's migration must be `supabase db push`-ed to cloud** to take
effect in prod (grants-only, safe).
