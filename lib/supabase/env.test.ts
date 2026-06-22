import { describe, expect, it } from "vitest";

import { readSupabaseEnv } from "./env";

describe("readSupabaseEnv", () => {
  it("returns url + anonKey from the provided source", () => {
    const env = readSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });

    expect(env).toEqual({
      url: "http://127.0.0.1:54321",
      anonKey: "anon-key",
    });
  });

  it("throws listing every missing var", () => {
    expect(() => readSupabaseEnv({})).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it("treats blank values as missing", () => {
    expect(() =>
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: "   ",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("does not read any service-role key (RLS-only per ADR 0003)", () => {
    const env = readSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "should-be-ignored",
    });

    expect(Object.values(env)).not.toContain("should-be-ignored");
  });
});
