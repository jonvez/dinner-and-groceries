/**
 * "Join your family" screen (issue #6, criterion 5; SPEC "Error Handling").
 *
 * A signed-in user with no `members` row is routed here by the middleware so
 * they never land on a broken empty app. Two paths are offered: create a new
 * household (owner), or accept an invite code (member). A user who arrives via
 * an invite link (`/join/[token]`) gets the code pre-filled.
 */

import { CreateHouseholdForm, AcceptInviteForm } from "./join-forms";

export const dynamic = "force-dynamic";

export default function JoinPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 p-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Join your family
        </h1>
        <p className="text-muted-foreground">
          You&apos;re signed in but not part of a household yet. Start one, or
          join with an invite from someone in your family.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Have an invite?</h2>
        <AcceptInviteForm />
      </section>

      <div className="flex items-center gap-3" aria-hidden>
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs uppercase">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Start a new household</h2>
        <CreateHouseholdForm />
      </section>

      <form action="/auth/signout" method="post" className="text-center">
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
