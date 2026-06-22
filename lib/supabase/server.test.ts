import { describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({ __client: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { createUserClient } from "./server";

const fakeEnv = {
  url: "http://127.0.0.1:54321",
  anonKey: "anon-key",
};

describe("createUserClient", () => {
  it("builds a client with the anon key + user-scoped Bearer header", () => {
    createClientMock.mockClear();

    createUserClient("user-jwt-123", fakeEnv);

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const [url, key, options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { global: { headers: Record<string, string> } },
    ];
    expect(url).toBe(fakeEnv.url);
    // Uses the anon key, NEVER a service-role key (ADR 0003).
    expect(key).toBe(fakeEnv.anonKey);
    expect(options.global.headers.Authorization).toBe("Bearer user-jwt-123");
  });

  it("refuses to build a client without a user access token", () => {
    expect(() => createUserClient("", fakeEnv)).toThrow(/access token is required/i);
  });
});
