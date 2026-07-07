/**
 * Typed server-side analytics emission helper (issue #16; ADR 0004 #3, SPEC
 * "Analytics & Outcome Tracking"). Framework-free and thin per the lib
 * conventions: it takes an injected Supabase-like client and inserts ONE row
 * into the append-only `events` table.
 *
 * Scope: this module is the shared emission primitive only. It does NOT wire
 * per-feature emission — each feature slice emits its own events from its own
 * Server Action in that slice's PR (see the migration's WIRING NOTE).
 *
 * Security contract:
 *   - `eventType` is the FIXED ADR 0004 taxonomy (the `EventType` union below is
 *     derived from the DB enum), so an out-of-taxonomy event is a COMPILE error —
 *     a feature slice can't invent an ad hoc event type.
 *   - Attribution is the pseudonymous app `memberId` ONLY. The input surface
 *     carries no Google identity / PII (no email/sub/user_id). `memberId` is
 *     optional so pre-membership usage events (e.g. `sign_in`) can be emitted.
 *   - `householdId` comes from the caller's VERIFIED session (never request
 *     input). RLS + the append-only policies scope + protect every write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

/** The analytics taxonomy of record (ADR 0004 #3), sourced from the DB enum. */
export type EventType = Database["public"]["Enums"]["event_type"];

/** A JSON-serializable, PII-free event payload. */
export type EventPayload = Database["public"]["Tables"]["events"]["Row"]["payload"];

export type EmitEventInput = {
  /** From the caller's verified session — never request input. */
  householdId: string;
  /** Constrained to the ADR 0004 taxonomy at compile time. */
  eventType: EventType;
  /** Pseudonymous app member. Omit/null for pre-membership usage events. */
  memberId?: string | null;
  /** Optional structured context. Defaults to `{}`. Must be PII-free. */
  payload?: EventPayload;
};

export type EmitResult = { ok: true } | { ok: false; error: string };

const GENERIC = "Failed to record analytics event.";

/**
 * Emit one analytics event. Fails closed (returns `{ ok: false }`) on any DB
 * error — analytics must never surface an error to, or block, the user flow;
 * the caller decides whether to ignore it (it should).
 */
export async function emitEvent(
  supabase: Pick<DbClient, "from">,
  input: EmitEventInput,
): Promise<EmitResult> {
  const { error } = await supabase.from("events").insert({
    household_id: input.householdId,
    member_id: input.memberId ?? null,
    event_type: input.eventType,
    payload: input.payload ?? {},
  });

  if (error) return { ok: false, error: GENERIC };
  return { ok: true };
}
