import { describe, expect, it, vi } from "vitest";

import {
  acceptInvite,
  createHousehold,
  generateInvite,
} from "./actions-core";

/**
 * These cover the household-create / invite / join action CORE — the pure
 * orchestration over an injected Supabase-like client — without a live DB or a
 * Google round-trip (per issue #6 "testing reality"). The SQL functions'
 * single-use/expiry/atomicity are covered by pgTAP (05_household_bootstrap).
 */

function rpcClient(impl: (fn: string, args: unknown) => { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (fn: string, args: unknown) => impl(fn, args));
  return { rpc } as unknown as Parameters<typeof createHousehold>[0];
}

function insertClient(result: { data: unknown; error: unknown }) {
  const select = vi.fn(() => ({
    single: vi.fn(async () => result),
  }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { from, _insert: insert } as unknown as Parameters<
    typeof generateInvite
  >[0] & { _insert: typeof insert };
}

describe("createHousehold", () => {
  it("rejects a blank household name before any DB call", async () => {
    const client = rpcClient(() => ({ data: "x", error: null }));
    const result = await createHousehold(client, { name: "  ", displayName: "Jon" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/name/i);
    expect((client.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("rejects a blank display name", async () => {
    const client = rpcClient(() => ({ data: "x", error: null }));
    const result = await createHousehold(client, { name: "Home", displayName: " " });
    expect(result.ok).toBe(false);
  });

  it("calls the create_household RPC with trimmed inputs and returns the household id", async () => {
    const client = rpcClient((fn, args) => {
      expect(fn).toBe("create_household");
      expect(args).toEqual({ p_name: "Our Home", p_display_name: "Jon" });
      return { data: "hh-1", error: null };
    });
    const result = await createHousehold(client, {
      name: "  Our Home  ",
      displayName: "  Jon  ",
    });
    expect(result).toEqual({ ok: true, householdId: "hh-1" });
  });

  it("surfaces a friendly error when the RPC fails (e.g. already a member)", async () => {
    const client = rpcClient(() => ({
      data: null,
      error: { message: "create_household: user already belongs to a household" },
    }));
    const result = await createHousehold(client, { name: "Home", displayName: "Jon" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("generateInvite", () => {
  it("mints a token via the injected minter and inserts an invite for the household", async () => {
    const client = insertClient({
      data: { token: "TOK", expires_at: "2026-07-01T00:00:00Z" },
      error: null,
    });
    const result = await generateInvite(client, {
      householdId: "hh-1",
      createdBy: "user-1",
      mintToken: () => "TOK",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe("TOK");
    expect(client._insert).toHaveBeenCalledWith({
      household_id: "hh-1",
      token: "TOK",
      created_by: "user-1",
    });
  });

  it("fails closed if the insert is rejected (e.g. RLS: not an owner)", async () => {
    const client = insertClient({
      data: null,
      error: { message: "new row violates row-level security policy" },
    });
    const result = await generateInvite(client, {
      householdId: "hh-1",
      createdBy: "user-1",
      mintToken: () => "TOK",
    });
    expect(result.ok).toBe(false);
  });
});

describe("acceptInvite", () => {
  it("rejects a blank token before any DB call", async () => {
    const client = rpcClient(() => ({ data: "x", error: null }));
    const result = await acceptInvite(client, { token: "  ", displayName: "Teen" });
    expect(result.ok).toBe(false);
    expect((client.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("rejects a blank display name", async () => {
    const client = rpcClient(() => ({ data: "x", error: null }));
    const result = await acceptInvite(client, { token: "good", displayName: "" });
    expect(result.ok).toBe(false);
  });

  it("calls accept_invite RPC with trimmed inputs and returns the household id", async () => {
    const client = rpcClient((fn, args) => {
      expect(fn).toBe("accept_invite");
      expect(args).toEqual({ p_token: "good-token", p_display_name: "Teen" });
      return { data: "hh-9", error: null };
    });
    const result = await acceptInvite(client, {
      token: "  good-token  ",
      displayName: "  Teen  ",
    });
    expect(result).toEqual({ ok: true, householdId: "hh-9" });
  });

  it("returns a clear error for a bad/expired/consumed invite (RPC raised)", async () => {
    const client = rpcClient(() => ({
      data: null,
      error: { message: "consume_invite: token already consumed" },
    }));
    const result = await acceptInvite(client, {
      token: "stale",
      displayName: "Teen",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invite/i);
  });
});
