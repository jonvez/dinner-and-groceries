// STUB (red): real implementation lands in the green commit.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const STUB = { ok: false as const, error: "not implemented" };

export async function getOrCreateSlot(
  _supabase: Pick<DbClient, "from">,
  _input: {
    householdId: string;
    weekId: string;
    dayOfWeek: number;
    mealType: string;
  },
): Promise<ActionResult<{ slotId: string }>> {
  return STUB;
}

export async function slotDish(
  _supabase: Pick<DbClient, "from">,
  _input: {
    householdId: string;
    weekId: string;
    dishId: string;
    dayOfWeek: number;
    mealType: string;
  },
): Promise<ActionResult<{ slotId: string; slotDishId: string }>> {
  return STUB;
}

export async function unslotDish(
  _supabase: Pick<DbClient, "from">,
  _input: { slotDishId: string },
): Promise<ActionResult<{ removed: true }>> {
  return STUB;
}
