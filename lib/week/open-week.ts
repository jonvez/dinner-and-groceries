/**
 * Opening a household's week — the small piece of week resolution shared by the
 * board (`app/board`) and the shopping list (`app/grocery`).
 *
 * Both screens must land on the SAME week row for a given day, so the logic
 * lives here once rather than being re-implemented per route (issue #15):
 *
 *   1. `loadWeekSettings` — the household's timezone + week-start day (ADR
 *      0003: the "current" week is resolved in the household's local time, not
 *      the server's, not UTC).
 *   2. `getOrCreateWeek` — lazily UPSERT the `weeks` row on the
 *      UNIQUE(household_id, start_date) key, so opening (or reopening) a week
 *      from either screen converges on exactly one row.
 *
 * The pure boundary math stays in `./boundary`. Injected client, so both are
 * unit-tested without a live DB; RLS does the household scoping (the reads
 * carry no household filter) and `householdId` is written explicitly on the
 * upsert because it is a NOT NULL denormalized column the INSERT policy checks.
 * Originally `getOrCreateWeek` lived in `app/board/actions-core.ts`; it moved
 * here unchanged when `/grocery` needed the same lazy week.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type OpenWeekResult =
  | { ok: true; weekId: string }
  | { ok: false; error: string };

/** Household week preferences, with the documented fallbacks applied. */
export type WeekSettings = {
  timezone: string;
  /** 0=Sun..6=Sat; Monday (1) by default. */
  weekStartDay: number;
};

export const DEFAULT_TIMEZONE = "America/Los_Angeles";
export const DEFAULT_WEEK_START_DAY = 1;

export async function loadWeekSettings(
  supabase: Pick<DbClient, "from">,
): Promise<WeekSettings> {
  // No household filter: RLS scopes this to the caller's own household.
  const { data } = await supabase
    .from("households")
    .select("timezone, week_start_day")
    .maybeSingle();

  return {
    timezone: data?.timezone ?? DEFAULT_TIMEZONE,
    weekStartDay: data?.week_start_day ?? DEFAULT_WEEK_START_DAY,
  };
}

export async function getOrCreateWeek(
  supabase: Pick<DbClient, "from">,
  input: { householdId: string; startDate: string },
): Promise<OpenWeekResult> {
  // UPSERT on the UNIQUE(household_id, start_date) key: opening (or reopening)
  // the week converges on exactly one row. On conflict the existing row's id is
  // preserved (ON CONFLICT DO UPDATE keeps the PK).
  const { data, error } = await supabase
    .from("weeks")
    .upsert(
      { household_id: input.householdId, start_date: input.startDate },
      { onConflict: "household_id,start_date" },
    )
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: "We couldn't open this week. Please try again." };
  }

  return { ok: true, weekId: data.id };
}
