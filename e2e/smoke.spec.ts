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

/**
 * Regression guard: the browser Supabase client must get its NEXT_PUBLIC_* env
 * INLINED into the client bundle. A dynamic `process.env` access (aliasing it to
 * a variable) is not statically replaced by Next, so the client throws
 * "Missing required Supabase env var(s)" the moment the sign-in button runs —
 * a bug that unit tests (which inject a fake env source) cannot catch.
 *
 * We capture uncaught page errors and click the button: with the env correctly
 * inlined there is no throw (the click then initiates the OAuth redirect). This
 * is independent of whether Supabase/Google is reachable, so it's CI-stable.
 */
test("clicking Google sign-in does not throw a missing-env error (client env is inlined)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.waitForTimeout(500);

  expect(pageErrors.join("\n")).not.toContain("Missing required Supabase env");
});

/**
 * Security headers (issue #55, phase 1) are actually served on a real response
 * — the issue's primary acceptance criterion ("inspect any page response
 * headers"). The CSP ships Report-Only this phase; HSTS is absent over local
 * http (the E2E server is plain http, exercising the non-prod branch).
 */
test("responses carry the security headers (CSP Report-Only, no HSTS on local http)", async ({
  page,
}) => {
  const response = await page.goto("/login");
  const headers = response!.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");

  // Report-Only this phase — the enforcing header must NOT be present yet.
  expect(headers["content-security-policy-report-only"]).toContain(
    "default-src 'self'",
  );
  expect(headers["content-security-policy"]).toBeUndefined();

  // Local dev is http, so HSTS must not be sent.
  expect(headers["strict-transport-security"]).toBeUndefined();
});
