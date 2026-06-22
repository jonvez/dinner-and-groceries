import { expect, test } from "@playwright/test";

/**
 * Smoke E2E: the app boots and the auth boundary works WITHOUT a real Google
 * round-trip (so this required check stays green with no Google creds).
 *
 * With no session cookie the middleware treats the visitor as signed-out: a
 * protected route redirects to /login, which offers Google sign-in only. This
 * exercises the real middleware + login page; it never contacts Google.
 *
 * Requires Supabase env vars so the middleware can construct its ssr client
 * (CI injects ephemeral local Supabase values; getUser() against it simply
 * returns "no user" for an anonymous request — see playwright.config.ts).
 */
test("a signed-out visitor is routed to the Google sign-in page", async ({
  page,
}) => {
  await page.goto("/");

  // Middleware bounced us to the login route.
  await expect(page).toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "Sign in to Dinner & Groceries" }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();

  // Only Google OAuth is wired — Apple is post-MVP.
  await expect(page.getByRole("button", { name: /apple/i })).toHaveCount(0);
});
