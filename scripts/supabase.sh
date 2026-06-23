#!/bin/sh
# Portable wrapper around the Supabase CLI for LOCAL dev (the `db:*` npm
# scripts). Two jobs:
#
#   1. Resolve the CLI without relying on a bare `supabase` on PATH. We use
#      `npx supabase`, which finds the pinned devDependency in node_modules (or
#      falls back to the npm cache) and works on a fresh checkout / CI.
#
#   2. Auto-load `.env.local` into the process env when it exists, so the
#      Supabase CLI's `env()` substitution in supabase/config.toml gets the
#      Google OAuth creds (SUPABASE_AUTH_EXTERNAL_GOOGLE_*). The CLI reads the
#      PROCESS env, NOT `.env.local` — without this the Google provider boots
#      disabled (empty creds -> "provider not enabled" 400 at authorize).
#
# It MUST stay correct when `.env.local` is absent (fresh checkout / CI): the
# load is guarded by an existence check, so `npm run db:start` still works with
# no Google creds (sign-in just can't complete a real round-trip).
#
# Usage: scripts/supabase.sh <supabase-subcommand...>
#   e.g. scripts/supabase.sh start
#        scripts/supabase.sh db reset

set -e

# Resolve the repo root from this script's location so the wrapper works no
# matter the caller's CWD (npm runs scripts from the package root anyway, but
# this keeps it robust under worktrees).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE="$ROOT_DIR/.env.local"
if [ -f "$ENV_FILE" ]; then
  # Export every assignment in .env.local into this process env. `set -a`
  # auto-exports; we source the file, then turn auto-export back off.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

exec npx supabase "$@"
