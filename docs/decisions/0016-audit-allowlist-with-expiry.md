# ADR 0016 — The weekly audit accepts unfixable advisories only via a scoped, expiring allowlist

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** **Jon** approved an allowlist with expiry over dropping dev dependencies from the
  audit (2026-10-05). The mechanism is below.
- **Relates to:** `.github/workflows/audit.yml`, `.deps-refresh.yml` (`tier: product`), #247 (the
  security fix that left `braces` as the only finding), failing run
  [37354692508](https://github.com/jonvez/dinner-and-groceries/actions/runs/37354692508),
  jonvez/rig#80 (deps-refresh false STOP found in the same pass).

## Context

On 2026-10-05 the weekly audit failed with 8 vulnerabilities (1 critical, 7 high). #247 fixed seven
of them (`next`, `undici`, `brace-expansion`). The last one cannot be fixed:

- **GHSA-vfj7-8cjw-p6xm**, `braces` (stack-exhaustion DoS), reached via
  `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`.
- Every `braces` version is flagged and the latest, 3.0.3, dates from 2024, so an `overrides` pin
  has nothing to pin to.
- `npm audit fix --force` "fixes" it by downgrading `eslint-config-next` to 14.x, two majors behind
  the Next 16 we ship. That is worse than the finding.
- It is a dev-only lint dependency that globs our own patterns. Exploiting it needs
  attacker-controlled glob input, which nothing here accepts.

`npm audit` cannot accept a single advisory. Left alone, the audit stays red until upstream acts,
and an always-red check is one nobody reads: the next real finding would sit behind it unnoticed.
Today's failure happened because fixes were sitting unmerged. A check people ignore makes that
worse.

## Options considered

1. **`npm audit --omit=dev`** (audit runtime dependencies only). Rejected. `.deps-refresh.yml`
   says why: dev-only still means "runs on Jon's machine and in CI with his credentials". It
   would also silently blind the audit to every future dev-tool advisory, not just this one.
2. **Raise the threshold to `--audit-level=critical`.** Rejected for the same reason, and worse,
   since it blinds runtime highs too.
3. **A third-party allowlisting tool** (`audit-ci`, `better-npm-audit`). Rejected. A new
   dependency that runs in CI goes through `third-party-security-review`, to buy about 60 lines
   of logic.
4. **A committed allowlist, read by a small in-repo script.** Chosen.

## Decision

`audit.yml` runs `npm run audit:gate` (`scripts/audit-gate.mjs`). It runs `npm audit --json` and
fails on every advisory at **moderate or above** unless `audit-allowlist.json` lists it. Each
exception:

- names **one GHSA id on one package**. A new advisory on an allowlisted package still fails, and
  so does the same GHSA on a different package;
- carries a **reason** (why it can't be fixed and why it isn't exploitable here) and points at
  this ADR;
- has an **`expires` date** (valid through that day). After it, the audit fails again until
  someone re-checks for a fix and then renews the exception on purpose or removes it.

The gate **fails closed**: an npm error payload (registry down, no network) or a malformed
allowlist throws rather than being read as "no vulnerabilities". An exception that no longer
matches anything is printed as stale but doesn't fail the run. It is harmless, and it expires
anyway.

The first exception is `braces` / GHSA-vfj7-8cjw-p6xm, **expiring 2027-01-05** (one quarter).

## Consequences

- The weekly audit goes green again and means something: red means a new or re-expired finding.
- Adding an exception is a reviewed diff to `audit-allowlist.json`. Under `tier: product` that
  needs the same human ack as any security-posture change. Don't add one to make a red run go
  away when a fix exists; fix it (the `deps-refresh` skill).
- Expiry is a recurring chore: about every quarter someone checks whether `braces` (or
  `eslint-config-next`'s globbing) has a fix. That cost is deliberate.
- Verified against the pre-#247 lockfile: the gate blocks all 11 real advisories (including the
  critical `next` RCE) and allows only `braces`.
