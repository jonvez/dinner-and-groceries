/**
 * Pure orchestration for the board's data writes (issue #8). Like the join
 * flow's `actions-core`, these take an injected Supabase-like client so they're
 * unit-tested WITHOUT a live DB. The thin Server Actions (`actions.ts`) build
 * the real cookie-session client (RLS in force — no service-role key), resolve
 * the caller's household + member identity, then call these.
 *
 * Modeling contract (SPEC "Deliberate modeling choices"; #7 schema):
 *   - `weeks` is lazily UPSERTed on (household_id, start_date) so reopening the
 *     board is idempotent — never a duplicate week (ADR 0003).
 *   - A brand-new proposal creates a `dishes` row (the reusable library entry)
 *     AND a `proposals` row for the week.
 *   - Recycling ("propose again") creates ONLY a `proposals` row pointing at the
 *     existing dish — no dish duplication.
 *
 * RLS does the household scoping; we pass `household_id` explicitly because it
 * is a NOT NULL denormalized column the INSERT policies check against.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type ActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Trim and collapse an optional free-text field to a value or null. */
function nullableText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Lazy week creation
// ---------------------------------------------------------------------------

export async function getOrCreateWeek(
  supabase: Pick<DbClient, "from">,
  input: { householdId: string; startDate: string },
): Promise<ActionResult<{ weekId: string }>> {
  // UPSERT on the UNIQUE(household_id, start_date) key: opening (or reopening)
  // the board converges on exactly one row for the period. On conflict the
  // existing row's id is preserved (ON CONFLICT DO UPDATE keeps the PK).
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

// ---------------------------------------------------------------------------
// Propose a brand-new dish (creates dish + proposal)
// ---------------------------------------------------------------------------

export async function proposeNewDish(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    weekId: string;
    proposedBy: string;
    title: string;
    sourceUrl: string;
    note: string;
  },
): Promise<ActionResult<{ proposalId: string; dishId: string }>> {
  const title = input.title.trim();
  if (title === "") {
    return { ok: false, error: "Give the dish a title." };
  }

  // 1) The reusable library dish. `source_url` is just a stored string here —
  //    no fetching/parsing (that's slice 1c).
  const { data: dish, error: dishError } = await supabase
    .from("dishes")
    .insert({
      household_id: input.householdId,
      title,
      source_url: nullableText(input.sourceUrl),
      created_by: input.proposedBy,
    })
    .select("id")
    .single();

  if (dishError || !dish) {
    return { ok: false, error: "We couldn't save that dish. Please try again." };
  }

  // 2) The proposal that puts it forward for THIS week.
  const proposal = await insertProposal(supabase, {
    householdId: input.householdId,
    weekId: input.weekId,
    dishId: dish.id,
    proposedBy: input.proposedBy,
    note: input.note,
  });

  if (!proposal.ok) return proposal;

  return { ok: true, proposalId: proposal.proposalId, dishId: dish.id };
}

// ---------------------------------------------------------------------------
// Recycle an existing library dish ("propose again") — proposal only
// ---------------------------------------------------------------------------

export async function proposeExistingDish(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    weekId: string;
    proposedBy: string;
    dishId: string;
    note: string;
  },
): Promise<ActionResult<{ proposalId: string }>> {
  if (input.dishId.trim() === "") {
    return { ok: false, error: "Pick a dish to propose again." };
  }

  // No `dishes` write — recycling never duplicates the library entry.
  const proposal = await insertProposal(supabase, {
    householdId: input.householdId,
    weekId: input.weekId,
    dishId: input.dishId,
    proposedBy: input.proposedBy,
    note: input.note,
  });

  if (!proposal.ok) return proposal;

  return { ok: true, proposalId: proposal.proposalId };
}

// ---------------------------------------------------------------------------
// Shared: insert the proposals row
// ---------------------------------------------------------------------------

async function insertProposal(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    weekId: string;
    dishId: string;
    proposedBy: string;
    note: string;
  },
): Promise<ActionResult<{ proposalId: string }>> {
  const { data, error } = await supabase
    .from("proposals")
    .insert({
      household_id: input.householdId,
      week_id: input.weekId,
      dish_id: input.dishId,
      proposed_by: input.proposedBy,
      note: nullableText(input.note),
    })
    .select("id")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: "We couldn't add that to the week. Please try again.",
    };
  }

  return { ok: true, proposalId: data.id };
}
