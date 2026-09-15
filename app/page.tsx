import Link from "next/link";

import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { resolveCurrentMember } from "./current-member";
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
 * Owners additionally get the invite generator here (criterion 2) and the only
 * link to the owner-only dashboard (#17, ADR 0014 §4 — it gets no nav entry);
 * both owner-only gates are enforced server-side (RLS on `invites` and on
 * `events`, plus a 404 on `/dashboard`), so this just shows/hides the UI.
 */
export default async function Home() {
  const supabase = await createServerComponentClient();

  // Scope "who am I" to the VERIFIED signed-in user. RLS lets any member read
  // ALL co-members, so an unfiltered read would return an arbitrary row (issue
  // #62); `resolveCurrentMember` pins the lookup to `auth.getUser()`'s id.
  const member = await resolveCurrentMember(supabase);
  const isOwner = member?.isOwner ?? false;

  return (
    <>
      <AppNav />
      <main className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-8 text-center">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Dinner &amp; Groceries
          </h1>
          <p className="text-muted-foreground max-w-md">
            {member?.displayName
              ? `Welcome back, ${member.displayName}.`
              : "Plan the family menu together, then let the grocery list flow from it."}
          </p>
        </div>

        <Link
          href="/board"
          className="bg-primary text-primary-foreground rounded-md px-5 py-2.5 text-sm font-medium"
        >
          Plan this week
        </Link>

        {isOwner ? (
          <>
            <InvitePanel />
            {/*
              The ONLY way into the PO dashboard (issue #17, ADR 0014 §4).
              Deliberately here and not in `AppNav`: the nav is a static,
              propless list rendered on every signed-in screen, and a
              "Dashboard" tab the teens can see but cannot open raises exactly
              the questions this feature must never raise. `/dashboard` 404s for
              a non-owner and `events_select` is owner-only in RLS, so this
              link is convenience, not the boundary.
            */}
            <Link
              href="/dashboard"
              className="text-muted-foreground text-sm underline underline-offset-4"
            >
              Dashboard
            </Link>
          </>
        ) : null}

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-muted-foreground text-sm underline underline-offset-4"
          >
            Sign out
          </button>
        </form>
      </main>
    </>
  );
}
