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

describe("updateSession — security headers (issue #55)", () => {
  it("sets the enforced baseline headers on the pass-through response", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("ships the CSP under the Report-Only header (phase 1 — not enforcing)", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-");
    // The enforcing header must NOT be sent this phase.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("still returns the Supabase session response with cookies intact", async () => {
    // Simulate the ssr client writing a refreshed-session cookie via setAll.
    const client = stubClient({ user: { id: "u1" }, hasMember: true });
    createServerClientMock.mockImplementation((_url, _key, opts) => {
      opts.cookies.setAll([
        { name: "sb-access-token", value: "refreshed", options: {} },
      ]);
      return client;
    });

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    // Session cookie preserved AND security headers present on the same response.
    expect(res.cookies.get("sb-access-token")?.value).toBe("refreshed");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("exposes the nonce to Next via the request CSP header (Report-Only variant)", async () => {
    // Next reads the nonce from the request's content-security-policy(-report-only)
    // header to stamp its own <script> tags. Assert we set it before rendering.
    const req = makeRequest("/board");
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    await updateSession(req, fakeEnv);

    expect(req.headers.get("Content-Security-Policy-Report-Only")).toContain(
      "script-src 'self' 'nonce-",
    );
  });

  it("carries the security headers onto a redirect response too", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: null, hasMember: false }),
    );

    const res = await updateSession(makeRequest("/board"), fakeEnv);

    expect(res.status).toBe(307);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain(
      "default-src 'self'",
    );
  });

  it("sends HSTS only when the request is https (prod), not on local http", async () => {
    createServerClientMock.mockReturnValue(
      stubClient({ user: { id: "u1" }, hasMember: true }),
    );

    const local = await updateSession(makeRequest("/board"), fakeEnv);
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();

    const prodReq = makeRequest("/board");
    prodReq.headers.set("x-forwarded-proto", "https");
    const prod = await updateSession(prodReq, fakeEnv);
    expect(prod.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });
});
