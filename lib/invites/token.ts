/**
 * Invite-token minting (issue #6, carried security flag from #27).
 *
 * The `invites.token` column only CHECKs `length > 0`, so token entropy is the
 * application's responsibility. We mint with Node's CSPRNG (`crypto.randomBytes`
 * — a cryptographically secure source, NOT `Math.random()`), then base64url-
 * encode so the token is URL-safe (usable as a path segment with no escaping)
 * and human-pasteable.
 *
 * Entropy decision: 24 random bytes = 192 bits. That is far above the 128-bit
 * floor for an unguessable single-use secret. Because the token is a long random
 * link secret (not a short human-typed code), the attack is online guessing
 * against `accept_invite`/`consume_invite`; 192 bits makes that infeasible
 * (~10^57 space) WITHOUT needing a guess-rate limiter. We deliberately did NOT
 * choose a short human-typeable code precisely so we could avoid the weaker
 * entropy + rate-limiting tradeoff that a short code would force. Invites are
 * also single-use and expiring (default 7 days, enforced in consume_invite),
 * which further bounds any window.
 */

import { randomBytes } from "node:crypto";

/** Random bytes per token. 24 bytes = 192 bits of entropy (>> 128-bit floor). */
export const INVITE_TOKEN_BYTES = 24;

export function mintInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}
