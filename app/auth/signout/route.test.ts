import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sign-out must CLEAR the session cookies on the response it returns (same
 * propagation bug as the callback, bug A). `auth.signOut()` emits the cleared
 * (empty / expired) session cookies through `setAll`; those writes have to land
 * on the returned redirect response or the browser keeps the stale session.
 */

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

const { cookieStoreMock } = vi.hoisted(() => ({
  cookieStoreMock: {
    getAll: vi.fn(() => [] as { name: string; value: string }[]),
    set: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStoreMock),
}));

vi.mock("@/lib/supabase/env", () => ({
  readSupabaseEnv: vi.fn(() => ({
    url: "http://127.0.0.1:54321",
    anonKey: "anon-key",
  })),
}));

import { POST } from "./route";

function stubSignOutClient() {
  let capturedSetAll:
    | ((cookies: { name: string; value: string; options: object }[]) => void)
    | undefined;

  createServerClientMock.mockImplementation((_url, _key, config) => {
    capturedSetAll = config.cookies.setAll;
    return {
      auth: {
        signOut: vi.fn(async () => {
          // The real client clears the session by writing empty cookies.
          capturedSetAll?.([
            { name: "sb-127-auth-token", value: "", options: { maxAge: 0 } },
          ]);
          return { error: null };
        }),
      },
    };
  });
}

function makeRequest() {
  return new NextRequest(new URL("http://localhost:3000/auth/signout"), {
    method: "POST",
  });
}

beforeEach(() => {
  createServerClientMock.mockReset();
});

describe("POST /auth/signout", () => {
  it("clears the session cookies on the redirect response it returns", async () => {
    stubSignOutClient();

    const res = await POST(makeRequest());

    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");

    const cleared = res.cookies.get("sb-127-auth-token");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
  });
});
