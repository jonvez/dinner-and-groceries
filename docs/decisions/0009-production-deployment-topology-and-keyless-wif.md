# ADR 0009 — Production deployment topology + keyless-WIF security tradeoff

- **Status:** Accepted
- **Date:** 2026-07-06
- **Decided by:** Jon (guardrail decisions on the #46 production decomposition)
- **Relates to:** ADR 0003 (CI/deploy posture, RLS-always-in-force), #46 (parent tracking issue), #50 (P0 GCP/WIF bootstrap), #53 (P3 activate deploy, subsumes #23). Runbook: `docs/runbooks/production-bringup.md`.

## Context

Slice 1b (the social loop) is validated locally; #46 takes it to real production on GCP.
The M0 CI pipeline (`.github/workflows/ci.yml`) already contains a **guarded deploy
stub** — Docker build → Artifact Registry → Cloud Run, authenticated via Workload
Identity Federation (WIF), gated on `vars.GCP_PROJECT_ID` so it is a no-op until GCP is
wired. This ADR records the **production topology** and the **keyless-WIF security
tradeoff** so the posture is settled before Jon runs the credentialed bootstrap (P0).

The decision space had two security-relevant axes:
1. **How CI authenticates to GCP** — a long-lived downloadable service-account JSON key
   vs keyless, short-lived OIDC via Workload Identity Federation.
2. **Cloud Run exposure** — whether the service is publicly reachable, and whether it
   stays warm or scales to zero.

## Decision

**Topology:** containerized Next.js on **GCP Cloud Run**, images in **Artifact Registry**
(`us-central1`, repo `app`), in GCP project **`dinner-and-groceries-prod`** (region
`us-central1`). Prod origin is the **default `https://<service>.run.app` URL**; a custom
domain is **deferred** (post-launch follow-up, no issue created).

- **Cloud Run:** `--allow-unauthenticated` (the *application* enforces auth via Supabase;
  Cloud Run IAM is not the auth boundary), **`--min-instances 0`** (scale-to-zero — a
  family MVP does not justify paying for a warm instance; cold starts are acceptable).
- **CI auth:** **keyless Workload Identity Federation only.** GitHub Actions presents its
  short-lived OIDC token; GCP exchanges it for a short-lived credential that impersonates
  a dedicated **deploy service account**. **No service-account JSON key** is ever created,
  downloaded, or stored in GitHub.
- **WIF trust is repo-pinned.** The WIF provider's **attribute condition** pins
  `assertion.repository == 'jonvez/dinner-and-groceries'`, and the deploy SA's
  `roles/iam.workloadIdentityUser` binding is scoped to the
  `principalSet://…/attribute.repository/jonvez/dinner-and-groceries` member only. No
  other repository or identity can impersonate the deploy SA.
- **Least-privilege SAs.** Deploy SA holds exactly `roles/run.admin`,
  `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` (to actAs the runtime
  SA) — no `owner`/`editor`. The Cloud Run **runtime** SA (the project default compute SA,
  matching the current `ci.yml` which sets no runtime-SA override) holds only
  `roles/secretmanager.secretAccessor`, scoped to the two Supabase secrets.
- **Repo variables (non-sensitive identifiers only):** `GCP_PROJECT_ID`, `GCP_REGION`,
  `GCP_AR_REPO`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA` — the exact names `ci.yml` reads.

### The keyless-WIF tradeoff (the security core of this ADR)

A downloadable JSON key is a **long-lived, exfiltratable bearer secret**: if it leaks
(committed, logged, stolen from a runner) it grants standing access until someone notices
and rotates it. WIF instead issues a **short-lived OIDC credential** minted per-run and
**gated by a repo-pinned attribute condition** — there is no durable secret to steal, and
the trust is bound to *this* repository's workflow identity. We accept WIF's added setup
complexity (pool/provider/condition/binding) in exchange for removing the single highest-
value, longest-lived credential from the system entirely.

## Consequences

**Positive**
- No long-lived GCP credential exists to leak; the attack surface is a short-lived,
  repo-pinned token. Compromise requires subverting GitHub's OIDC *and* matching the
  `jonvez/dinner-and-groceries` attribute condition.
- Scale-to-zero keeps the family MVP's hosting cost near-zero (cost posture preserved).
- Least-privilege SAs bound the blast radius of any single-identity compromise.
- Pipeline shape is unchanged — this activates an already-reviewed stub (ADR 0003).

**Negative / residual risk**
- `--allow-unauthenticated` means the origin is publicly reachable; **all** access control
  is the app's Supabase auth + RLS. This is intentional (Cloud Run IAM cannot express
  "signed-in household member"), and is exactly why P4 (Realtime-on-cloud gate) and the RLS
  guards matter. Security headers/CSP (P5, subsumes #20) harden the public surface.
- Scale-to-zero adds cold-start latency on the first request after idle — acceptable for
  4 users.
- WIF setup is fiddly and easy to misconfigure; the runbook § P0 pins the exact condition
  and binding to reduce that risk. A too-broad attribute condition would be a real
  vulnerability — the DoD in #50 requires verifying the condition string.

**Alternatives considered**
- *Service-account JSON key* — simpler, but a long-lived exfiltratable secret; rejected on
  the tradeoff above.
- *Cloud Run `--no-allow-unauthenticated` + IAM invoker* — cannot express app-level
  household membership; would require a proxy/IAP layer that adds cost and complexity for
  no security gain over app-enforced Supabase auth. Rejected for the MVP.
- *`--min-instances 1`* (warm) — rejected on cost posture for a family MVP.

## Follow-ups
- Custom domain (map to the Cloud Run service) — post-launch, not tracked as an issue yet.
- Dedicated minimal Cloud Run **runtime** SA (instead of the default compute SA) — a
  hardening follow-up; the default compute SA is used now to keep `ci.yml` unchanged.
