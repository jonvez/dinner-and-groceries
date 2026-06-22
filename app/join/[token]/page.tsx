/**
 * Invite-link landing (issue #6, criterion 3). A would-be member opens
 * `/join/<token>` (after signing in with Google — the middleware guarantees a
 * session and that they have no household yet). We validate the token shape at
 * the boundary and pre-fill the accept form; the actual single-use consumption
 * happens server-side in `accept_invite` when they submit.
 */

import { notFound } from "next/navigation";

import { parseInviteToken } from "@/lib/invites/url";

import { AcceptInviteForm } from "../join-forms";

export const dynamic = "force-dynamic";

export default async function JoinWithTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token: raw } = await params;
  const token = parseInviteToken(decodeURIComponent(raw));

  // A malformed token never reaches the DB — show the not-found boundary.
  if (!token) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 p-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Join your family
        </h1>
        <p className="text-muted-foreground">
          You&apos;ve been invited. Enter the name you&apos;ll go by to join.
        </p>
      </div>

      <AcceptInviteForm token={token} />

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
