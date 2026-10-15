#!/usr/bin/env bash
# Start the local Supabase stack in CI (the `rls` and `e2e` jobs).
#
# Retries a transient failure up to three times, cleaning up in between, but
# FAILS FAST on a registry rate limit (#236). A rate limit counts attempts, so
# each retry spends the quota it is waiting for: three attempts × 13 images,
# doubled by a manual re-run, burned ~78 pulls per logical run and turned a
# 5-minute failure into a 12-minute one.
#
# The images come from ghcr.io (SUPABASE_INTERNAL_IMAGE_REGISTRY, set on the
# job, plus a docker/login-action step with the job's GITHUB_TOKEN), not the
# CLI's default anonymous public.ecr.aws. See ADR 0017. A rate limit here
# therefore means that login or override is missing.
#
# SUPABASE_START_CMD / SUPABASE_STOP_CMD / SUPABASE_START_BACKOFF exist for
# scripts/ci/supabase-start.test.ts; CI uses the defaults.
set -uo pipefail

start=${SUPABASE_START_CMD:-npx supabase start}
stop=${SUPABASE_STOP_CMD:-npx supabase stop --no-backup}
backoff=${SUPABASE_START_BACKOFF:-15}
log=$(mktemp)
trap 'rm -f "$log"' EXIT

for attempt in 1 2 3; do
  # tee keeps the CLI's own output in the job log; pipefail keeps its status.
  if bash -c "$start" 2>&1 | tee "$log"; then exit 0; fi

  if grep -q "toomanyrequests" "$log"; then
    echo "::error::supabase start hit a registry rate limit (toomanyrequests). Not retrying: retries spend the quota they wait for. Check that SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io and the ghcr.io login step are in place for this job (#236, ADR 0017)."
    exit 1
  fi

  [ "$attempt" = 3 ] && break
  echo "supabase start failed (attempt $attempt) — cleaning up and retrying"
  bash -c "$stop" || true
  sleep $((attempt * backoff))
done

echo "::error::supabase start failed after 3 attempts"
exit 1
