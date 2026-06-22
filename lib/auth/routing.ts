/**
 * The auth-boundary routing decision — framework-free so it is unit-tested in
 * isolation and reused by both the Next.js middleware (request-time gate) and
 * server components.
 *
 * It encodes four states (issue #5 acceptance criteria):
 *   1. signed-out on a protected route  -> redirect to /login (preserving where
 *      they were headed in a *validated* `next`).
 *   2. signed-in, NO `members` row      -> route onward to the join flow
 *      (`/join`). The join *screen* is #6's scope; here we only make the
 *      routing decision so a member-less user never lands on a broken app.
 *   3. signed-in, has a member row       -> proceed.
 *   4. already-authenticated users on /login (or a no-member user reaching the
 *      join placeholder) are sent to the right place rather than looping.
 *
 * It never makes a network/DB call itself — callers pass the resolved
 * `isAuthenticated` / `hasMember` facts. That keeps the security-critical
 * branching pure and exhaustively testable.
 */

import { safeRedirectPath } from "./redirect";

export const LOGIN_PATH = "/login";
export const JOIN_PATH = "/join";
export const HOME_PATH = "/";

/**
 * Paths an unauthenticated visitor may reach: the login page and the `/auth/*`
 * endpoints (the OAuth callback that *establishes* the session, plus sign-out).
 */
export function isPublicPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname.startsWith("/auth/");
}

export type AuthRouteInput = {
  isAuthenticated: boolean;
  hasMember: boolean;
  pathname: string;
  /** Untrusted redirect target carried on the URL (validated before use). */
  next?: string | null;
};

export type AuthRouteDecision =
  | { action: "next" }
  | { action: "redirect"; to: string };

export function resolveAuthRoute(input: AuthRouteInput): AuthRouteDecision {
  const { isAuthenticated, hasMember, pathname } = input;
  const onLogin = pathname === LOGIN_PATH;
  // The whole `/join` subtree is the join flow: bare `/join` plus invite links
  // `/join/<token>`. A member-less user must be able to land on an invite link
  // WITHOUT the middleware bouncing them to bare `/join` (which would drop the
  // token), and a member must be bounced off any of them.
  const onJoin = pathname === JOIN_PATH || pathname.startsWith(`${JOIN_PATH}/`);
  const isAuthEndpoint = pathname.startsWith("/auth/");

  // ---- signed-out --------------------------------------------------------
  if (!isAuthenticated) {
    // Public surfaces (login page + the OAuth/sign-out endpoints) stay open;
    // the callback endpoint is what *establishes* the session, so it must
    // never be gated.
    if (isPublicPath(pathname)) return { action: "next" };

    // Everything else requires a session: bounce to login, remembering the
    // destination so we can return there after sign-in.
    const next = encodeURIComponent(pathname);
    return { action: "redirect", to: `${LOGIN_PATH}?next=${next}` };
  }

  // ---- signed-in, but no household membership ----------------------------
  // Route onward to the join flow rather than a broken empty app. The auth
  // endpoints still pass through (e.g. sign-out must work from any state).
  if (!hasMember) {
    if (onJoin || isAuthEndpoint) return { action: "next" };
    return { action: "redirect", to: JOIN_PATH };
  }

  // ---- signed-in with a member row ---------------------------------------
  // A fully-onboarded user has no business on the login or join screens.
  if (onLogin) {
    return { action: "redirect", to: safeRedirectPath(input.next, HOME_PATH) };
  }
  if (onJoin) {
    return { action: "redirect", to: HOME_PATH };
  }

  return { action: "next" };
}
