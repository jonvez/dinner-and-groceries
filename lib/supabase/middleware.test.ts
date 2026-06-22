import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

import { updateSession } from "./middleware";

const fakeEnv = {
  url: "http://127.0.0.1:54321",
  anonKey: "anon-key",
};

/**
 * Build a fake supabase client whose getUser()/membership query return the
 * given facts. We only stub the surface `updateSession` touches.
 */
function stubClient(opts: {
  user: { id: string } | null;
  hasMember: boolean;
}) {
  const maybeSingle = vi.fn(async () => ({
    data: opts.hasMember ? { id: "member-1" } : null,
    error: null,
  }));
  const limit = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: opts.user },
        error: null,
      })),
    },
    from,
    __members: { from, select, eq, limit, maybeSingle },
  };
}

function makeRequest(path: string) {
  return new NextRequest(new URL(`http://127.0.0.1:3000${path}`));
}

beforeEach(() => {
  createServerClientMock.mockReset();
});

describe("updateSession", () => {
  it("redirects a signed-out visitor on a protected route to /login", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: null, hasMember: false }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/board");
  });

  it("verifies identity with getUser() (not getSession) — RLS/authz must use a verified user", async () => {
    const client = stubClient({ user: null, hasMember: false });
    createServerClientMock.mockReturnValue(client);

    await updateSession(makeRequest("/board"), fakeEnv);

    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("routes a signed-in user with NO member row to /join", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: false }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/join");
  });

  it("scopes the membership lookup to the signed-in user's id (RLS-correct)", async () => {
    const client = stubClient({ user: { id: "user-42" }, hasMember: false });
    createServerClientMock.mockReturnValue(client);

    await updateSession(makeRequest("/board"), fakeEnv);

    expect(client.__members.from).toHaveBeenCalledWith("members");
    expect(client.__members.eq).toHaveBeenCalledWith("user_id", "user-42");
  });

  it("lets a fully signed-in member through (no redirect)", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    // pass-through response has no Location redirect
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes the anon key to createServerClient (never a service-role key)", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    await updateSession(makeRequest("/board"), fakeEnv);

    const [url, key] = createServerClientMock.mock.calls[0];
    expect(url).toBe(fakeEnv.url);
    expect(key).toBe(fakeEnv.anonKey);
  });

  it("does not query membership for a signed-out visitor", async () => {
    const client = stubClient({ user: null, hasMember: false });
    createServerClientMock.mockReturnValue(client);

    await updateSession(makeRequest("/login"), fakeEnv);

    expect(client.__members.from).not.toHaveBeenCalled();
  });
});
