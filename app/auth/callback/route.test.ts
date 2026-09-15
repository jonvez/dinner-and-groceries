import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Regression guard for the local-auth blocker (bug A): a successful OAuth code
 * exchange MUST return a redirect response that CARRIES the session cookies as
 * `Set-Cookie` headers. The original implementation wrote cookies to the
 * `next/headers` store and then returned a *fresh* `NextResponse.redirect()`
 * that never received them — so `exchangeCodeForSession` succeeded yet the
 * browser was never handed the `sb-*` session cookies, and the very next
 * request to `/` was bounced back to `/login` by the middleware.
 *
 * We mock `@supabase/ssr` so the fake client's `exchangeCodeForSession`
 * triggers `setAll` (exactly what the real SSR client does once the exchange
 * succeeds), then assert the returned response advertises those cookies.
 *
 * It also covers `sign_in` emission (issue #210). `events.household_id` is NOT
 * NULL and the INSERT policy checks it against `current_household_id()`, so a
 * brand-new user has nothing to attribute the event to: emit only when the
 * household resolves, and NEVER let analytics fail or change the sign-in.
 */

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

// `cookies()` from next/headers must resolve in the route-handler context; we
// give it a minimal in-memory store so the route can read incoming cookies.
const { cookieStoreMock } = vi.hoisted(() => ({
  cookieStoreMock: {
    getAll: vi.fn(() => [] as { name: string; value: string }[]),
    set: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStoreMock),
}));

import { readSupabaseEnv } from "@/lib/supabase/env";

vi.mock("@/lib/supabase/env", () => ({
  readSupabaseEnv: vi.fn(() => ({
    url: "http://127.0.0.1:54321",
    anonKey: "anon-key",
  })),
}));

import { GET } from "./route";

const SESSION_COOKIES = [
  { name: "sb-127-auth-token", value: "access-token-value", options: {} },
  {
    name: "sb-127-auth-token.1",
    value: "refresh-token-value",
    options: {},
  },
];

/** Analytics rows the route inserted, recorded by the fake client below. */
const inserts: { table: string; vals: Record<string, unknown> }[] = [];

type StubOptions = {
  error?: unknown;
  /** What `current_household_id()` resolves to (null = no household yet). */
  householdId?: string | null;
  /** The member row for the signed-in user (null = none). */
  memberId?: string | null;
  /** Make the analytics insert blow up mid-flight. */
  throwOnInsert?: boolean;
};

/**
 * Build a fake SSR client. When `exchangeCodeForSession` is called we invoke
 * the captured `setAll` with the session cookies — mirroring the real client,
 * which writes the session cookies through the `setAll` callback on success.
 * It also answers the `current_household_id()` RPC, the member lookup and the
 * `events` insert, so `sign_in` emission is assertable on the real row.
 */
function stubClientThatSetsCookies(opts: StubOptions = {}) {
  const {
    error = null,
    householdId = "hh-1",
    memberId = "m-1",
    throwOnInsert = false,
  } = opts;
  let capturedSetAll: ((cookies: typeof SESSION_COOKIES) => void) | undefined;

  createServerClientMock.mockImplementation((_url, _key, config) => {
    capturedSetAll = config.cookies.setAll;
    return {
      auth: {
        exchangeCodeForSession: vi.fn(async () => {
          if (!error) {
            capturedSetAll?.(SESSION_COOKIES);
          }
          return {
            data: { user: error ? null : { id: "auth-user-1" } },
            error,
          };
        }),
      },
      rpc: vi.fn(async () => ({ data: householdId })),
      from: vi.fn((table: string) => ({
        insert: (vals: Record<string, unknown>) => {
          if (throwOnInsert) throw new Error("analytics transport down");
          inserts.push({ table, vals });
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: memberId ? { id: memberId } : null,
            }),
          }),
        }),
      })),
    };
  });
}

function emitted() {
  return inserts.filter((row) => row.table === "events").map((row) => row.vals);
}

function makeRequest(query: string) {
  return new NextRequest(new URL(`http://localhost:3000/auth/callback${query}`));
}

beforeEach(() => {
  inserts.length = 0;
  createServerClientMock.mockReset();
  cookieStoreMock.getAll.mockReset().mockReturnValue([]);
  cookieStoreMock.set.mockReset();
  vi.mocked(readSupabaseEnv).mockReturnValue({
    url: "http://127.0.0.1:54321",
    anonKey: "anon-key",
  });
});

describe("GET /auth/callback", () => {
  it("returns a redirect that CARRIES the session cookies (Set-Cookie on the response)", async () => {
    stubClientThatSetsCookies();

    const res = await GET(makeRequest("?code=valid-code"));

    // SUCCESS path: redirect to the app, not to /login?error=oauth.
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    // The crux of bug A: the session cookies must ride on THIS response.
    const setCookieNames = res.cookies.getAll().map((c) => c.name);
    expect(setCookieNames).toContain("sb-127-auth-token");
    expect(setCookieNames).toContain("sb-127-auth-token.1");

    // And the raw Set-Cookie header(s) must be present (what the browser sees).
    const rawSetCookie = res.headers.get("set-cookie") ?? "";
    expect(rawSetCookie).toContain("sb-127-auth-token");
  });

  it("honors a validated ?next path on the success redirect (cookies still attached)", async () => {
    stubClientThatSetsCookies();

    const res = await GET(makeRequest("?code=valid-code&next=/join"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/join");
    expect(res.cookies.get("sb-127-auth-token")?.value).toBe(
      "access-token-value",
    );
  });

  it("emits exactly one sign_in when the caller already has a household", async () => {
    stubClientThatSetsCookies();

    const res = await GET(makeRequest("?code=valid-code"));

    expect(res.status).toBe(307);
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "sign_in",
        payload: {},
      },
    ]);
  });

  it("emits NOTHING for a first-time user with no household, and still signs them in", async () => {
    stubClientThatSetsCookies({ householdId: null, memberId: null });

    const res = await GET(makeRequest("?code=valid-code&next=/join"));

    // `events.household_id` is NOT NULL — there is nothing to attribute to yet.
    expect(emitted()).toEqual([]);
    // The sign-in is untouched: still a cookie-carrying redirect to /join.
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/join");
    expect(res.cookies.get("sb-127-auth-token")?.value).toBe(
      "access-token-value",
    );
  });

  it("signs the user in normally when the analytics insert THROWS", async () => {
    stubClientThatSetsCookies({ throwOnInsert: true });

    const res = await GET(makeRequest("?code=valid-code"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(res.cookies.get("sb-127-auth-token")?.value).toBe(
      "access-token-value",
    );
  });

  it("emits no sign_in when the code exchange fails", async () => {
    stubClientThatSetsCookies({ error: new Error("bad code") });

    await GET(makeRequest("?code=bad-code"));

    expect(emitted()).toEqual([]);
  });

  it("redirects to /login?error=oauth and sets NO session cookies when the exchange fails", async () => {
    stubClientThatSetsCookies({ error: new Error("bad code") });

    const res = await GET(makeRequest("?code=bad-code"));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("oauth");
    expect(res.cookies.getAll()).toHaveLength(0);
  });

  it("redirects to /login?error=oauth when no code is present (provider error)", async () => {
    const res = await GET(makeRequest("?error=access_denied"));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("oauth");
    // No client should be constructed when there is nothing to exchange.
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});
