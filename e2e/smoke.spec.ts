import { expect, test } from "@playwright/test";

// Smoke E2E: the app loads and `/` renders. Runs against `next start`
// (production build) and does NOT require Supabase, so it is green today.
// TODO(#2): once supabase/ lands, an ephemeral Supabase DB is spun up in CI
// (see .github/workflows/ci.yml, guarded on supabase/config.toml) and richer
// data-backed E2E flows can build on this harness.
test("app loads and / renders", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Dinner & Groceries" }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Get started" }),
  ).toBeVisible();
});
