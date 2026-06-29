import { describe, expect, it, vi } from "vitest";

import { resolveRealtimeToken } from "./route-core";

/**
 * The Realtime token endpoint hands the BROWSER its short-lived access token so
 * the websocket can authenticate as the signed-in user (issue #44). It must:
 *   - verify the identity with auth.getUser() (the verified JWT), and
 *   - return ONLY the short-lived access token (never the refresh token),
 * failing closed (401) for any caller without a real session.
 */

function fakeClient({
  user,
  session,
}: {
  user: { id: string } | null;
  session: { access_token?: string; refresh_token?: string; expires_at?: number } | null;
}) {
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: null })),
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
    },
  };
  return client as unknown as Parameters<typeof resolveRealtimeToken>[0] & {
    auth: { getUser: typeof client.auth.getUser };
  };
}

describe("resolveRealtimeToken", () => {
  it("returns the access token + expiry for a verified, signed-in user", async () => {
    const client = fakeClient({
      user: { id: "u1" },
      session: {
        access_token: "access-jwt",
        refresh_token: "refresh-secret",
        expires_at: 1_900_000_000,
      },
    });
    const result = await resolveRealtimeToken(client);
    expect(result).toEqual({
      ok: true,
      token: "access-jwt",
      expiresAt: 1_900_000_000,
    });
  });

  it("verifies identity via getUser() (not the unverified session alone)", async () => {
    const client = fakeClient({
      user: { id: "u1" },
      session: { access_token: "access-jwt", expires_at: 1 },
    });
    await resolveRealtimeToken(client);
    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("NEVER exposes the refresh token in the result", async () => {
    const client = fakeClient({
      user: { id: "u1" },
      session: {
        access_token: "access-jwt",
        refresh_token: "refresh-secret",
        expires_at: 1,
      },
    });
    const result = await resolveRealtimeToken(client);
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
  });

  it("fails closed (ok:false) when there is no verified user", async () => {
    const client = fakeClient({
      user: null,
      session: { access_token: "access-jwt", expires_at: 1 },
    });
    expect(await resolveRealtimeToken(client)).toEqual({ ok: false });
  });

  it("fails closed when verified but the session has no access token", async () => {
    const client = fakeClient({ user: { id: "u1" }, session: null });
    expect(await resolveRealtimeToken(client)).toEqual({ ok: false });
  });
});
