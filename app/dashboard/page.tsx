import { notFound } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { loadDashboardSummary } from "@/lib/analytics/dashboard";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { resolveCurrentMember } from "../current-member";
import { DashboardPanels } from "./dashboard-panels";

// Per-user, session-dependent, and owner-gated: never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * The PO dashboard (issue #17, slice 1e; ADR 0014) — adoption, per-member
 * participation and trips over a fixed 30-day window, read from the append-only
 * `events` table.
 *
 * OWNER-ONLY, in two layers:
 *
 *   1. **RLS is the boundary.** `events_select` requires
 *      `public.is_household_owner()` (migration 20260916120000), so a non-owner
 *      reads ZERO event rows even through the Data API, with this route out of
 *      the picture entirely. That is the layer that actually protects the data;
 *      pgTAP proves it in `supabase/tests/15_events_rls_test.sql`.
 *   2. **This route's behaviour is a 404.** `resolveCurrentMember` pins the
 *      membership lookup to the VERIFIED `auth.getUser()` id (the #62 lesson —
 *      `members_select` lets any member read all co-members, so an unfiltered
 *      read returns the owner's row), and a non-owner gets `notFound()`. 404
 *      rather than 403: a member who cannot have this screen should not learn
 *      that it exists. Nothing is read before the gate, so a non-owner's
 *      request touches no event data at all.
 *
 * The middleware has already guaranteed a signed-in member with a household
 * (`lib/auth/routing.ts`); a signed-out visitor is redirected to `/login` with
 * a validated `next` and never reaches this file. The owner check is the layer
 * on top of that.
 *
 * North star: this screen exists for the parent alone. There is no nav entry
 * (ADR 0014 §4 — a "Dashboard" tab the teens can see but cannot open invites
 * exactly the questions this feature must never raise); the only link lives in
 * the owner-only region of Home. Nothing here is kid-facing, and there is no
 * health/tag figure at all (that panel is #211, blocked on the M2 pick-list).
 */
export default async function DashboardPage() {
  const supabase = await createServerComponentClient();

  const member = await resolveCurrentMember(supabase);
  // Fail closed: no verified session, no membership row, or not the owner.
  if (!member?.isOwner) notFound();

  const summary = await loadDashboardSummary(supabase);

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm">
            How the family is planning and shopping together. Only you can see this.
          </p>
        </header>

        <DashboardPanels summary={summary} />
      </main>
    </>
  );
}
