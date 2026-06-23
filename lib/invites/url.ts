/**
 * Invite-link URL construction + token parsing (issue #6).
 *
 * An invite is shared as `<origin>/join/<token>`. The token is a base64url
 * CSPRNG secret (see token.ts). `parseInviteToken` validates an untrusted path
 * segment before it is ever handed to the `accept_invite` RPC: it must be a
 * non-empty, length-capped string drawn from the base64url alphabet. That
 * rejects path-traversal-shaped (`../…`) and otherwise malformed tokens at the
 * boundary, so only well-formed candidates reach the DB.
 */

export const INVITE_PATH = "/join";

/** Defensive upper bound on an inbound token (our tokens are ~32 chars). */
const MAX_TOKEN_LENGTH = 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function inviteUrl(token: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${INVITE_PATH}/${encodeURIComponent(token)}`;
}

/**
 * Validate + normalize an untrusted token from a URL path. Returns the trimmed
 * token, or null if it is empty, too long, or contains out-of-alphabet
 * characters.
 */
export function parseInviteToken(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (token === "") return null;
  if (token.length > MAX_TOKEN_LENGTH) return null;
  if (!BASE64URL.test(token)) return null;
  return token;
}
