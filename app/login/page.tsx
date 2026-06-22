import { safeRedirectPath } from "@/lib/auth/redirect";

import { GoogleSignInButton } from "./google-button";

/**
 * Sign-in page. Signed-out visitors land here (middleware redirects protected
 * routes to `/login?next=…`). Only Google OAuth is offered — Apple is
 * explicitly post-MVP (#5).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);
  const hadError = params.error === "oauth";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Sign in to Dinner &amp; Groceries
        </h1>
        <p className="text-muted-foreground max-w-md">
          Sign in with your own Google account so your proposals and reactions
          are recognizably yours.
        </p>
      </div>

      {hadError ? (
        <p role="alert" className="text-destructive text-sm">
          Sign-in didn&apos;t complete. Please try again.
        </p>
      ) : null}

      <GoogleSignInButton next={next} />
    </main>
  );
}
