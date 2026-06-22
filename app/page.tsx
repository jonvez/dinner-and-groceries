import { createServerComponentClient } from "@/lib/supabase/server-component";

import { InvitePanel } from "./invite-panel";

// Per-user, session-dependent: never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Home (protected). The middleware guarantees that anyone reaching this route
 * is signed in AND has a household membership, so we can read the member's
 * profile through the RLS-scoped cookie-session client (criterion 4: the
 * user's access token, never a service-role key).
 *
 * This is the "land in the shared household" state (issue #6, criterion 6) — a
 * basic authenticated household-home. The week-board / proposals UI is Slice 1b.
 * Owners additionally get the invite generator here (criterion 2); the
 * owner-only gate is RLS-enforced, this just shows/hides the panel.
 */
export default async function Home() {
  const supabase = await createServerComponentClient();

  // Runs as the signed-in user; RLS limits this to their own household.
  const { data: member } = await supabase
    .from("members")
    .select("display_name, role")
    .limit(1)
    .maybeSingle();

  const isOwner = member?.role === "owner";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Dinner &amp; Groceries
        </h1>
        <p className="text-muted-foreground max-w-md">
          {member?.display_name
            ? `Welcome back, ${member.display_name}.`
            : "Plan the family menu together, then let the grocery list flow from it."}
        </p>
      </div>

      {isOwner ? <InvitePanel /> : null}

      <form action="/auth/signout" method="post">
        <button
          type="submit"
          className="text-muted-foreground text-sm underline underline-offset-4"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
