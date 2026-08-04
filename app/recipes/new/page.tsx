import { AppNav } from "@/components/app-nav";

import { RecipeIngestForm } from "./recipe-ingest-form";

// safeFetchHtml (issue #76) opens raw sockets via node:http/https/dns/net — this
// route (and the Server Actions it invokes) must run in the Node.js runtime,
// not Edge, where those modules are unavailable. Pinned explicitly per the #12
// design of record's security requirements, even though Node is already this
// app's platform-wide default.
export const runtime = "nodejs";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// shell — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Add-a-recipe screen (issue #12c): paste a URL to fetch + extract a preview,
 * or skip straight to the by-hand editor. Nothing is persisted until Save —
 * see `recipe-ingest-form.tsx` for the two-stage fetch/save flow and
 * `ingest-core.ts` for the orchestration it wraps.
 */
export default function NewRecipePage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add a recipe</h1>
        <RecipeIngestForm />
      </main>
    </>
  );
}
