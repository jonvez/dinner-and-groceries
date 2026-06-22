/**
 * Join-flow placeholder (issue #5, criterion 5).
 *
 * A signed-in user with no `members` row is routed here by the middleware so
 * they never land on a broken empty app. The actual household-create / invite /
 * join experience is issue #6's scope — this page only marks the boundary.
 */
export default function JoinPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          You&apos;re signed in
        </h1>
        <p className="text-muted-foreground max-w-md">
          You&apos;re not part of a household yet. Creating or joining a
          household lands in the next step.
        </p>
      </div>

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
