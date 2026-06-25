import { describe, expect, it, vi } from "vitest";

import { REACTION_PALETTE } from "@/lib/social/palette";

import { addComment, toggleReaction } from "./social-core";

/**
 * Pure orchestration for the social writes (issue #9), tested over an injected
 * Supabase-like client — no live DB (RLS household-scoping is proven by pgTAP /
 * #7). Here we pin the application contract:
 *   - the reaction toggle is idempotent on (proposal_id, member_id, kind): an
 *     existing row is DELETEd (toggle off), an absent one INSERTed (toggle on),
 *   - the reaction `kind` is constrained to the palette SERVER-SIDE (untrusted
 *     client input is rejected before any DB call),
 *   - identity (`householdId`/`memberId`) is always passed by the caller from the
 *     verified session — never read from these functions' free-text inputs,
 *   - a comment body is normalized + length-capped before insert.
 */

const [KIND] = REACTION_PALETTE;

type Result = { data: unknown; error: unknown };

/**
 * Fake client. `existing` is what the "did this member already react?" lookup
 * returns; `insertResult` / `deleteError` drive the write outcomes. Records the
 * tables touched and the values inserted/deleted so the contract is assertable.
 */
function makeClient(opts: {
  existing?: Result;
  insertResult?: Result;
  deleteError?: unknown;
}) {
  const tables: string[] = [];
  const inserts: { table: string; vals: unknown }[] = [];
  const deletes: { table: string; column: string; value: unknown }[] = [];

  const from = vi.fn((table: string) => {
    tables.push(table);
    return {
      // reactions lookup: .select().eq().eq().eq().maybeSingle()
      select: vi.fn(() => {
        const chain = {
          eq: vi.fn(() => chain),
          maybeSingle: async () => opts.existing ?? { data: null, error: null },
        };
        return chain;
      }),
      insert: vi.fn((vals: unknown) => {
        inserts.push({ table, vals });
        return {
          select: () => ({
            single: async () =>
              opts.insertResult ?? { data: { id: "new-id" }, error: null },
          }),
        };
      }),
      delete: vi.fn(() => ({
        eq: vi.fn(async (column: string, value: unknown) => {
          deletes.push({ table, column, value });
          return { error: opts.deleteError ?? null };
        }),
      })),
    };
  });

  return {
    client: { from } as unknown as Parameters<typeof toggleReaction>[0],
    calls: { tables, inserts, deletes },
  };
}

const REACT_INPUT = {
  householdId: "hh-1",
  proposalId: "p1",
  memberId: "m1",
  kind: KIND,
};

describe("toggleReaction", () => {
  it("inserts a reaction when the member has not reacted with this kind (toggle on)", async () => {
    const { client, calls } = makeClient({
      existing: { data: null, error: null },
      insertResult: { data: { id: "r1" }, error: null },
    });

    const result = await toggleReaction(client, REACT_INPUT);

    expect(result).toEqual({ ok: true, toggled: "on" });
    expect(calls.inserts).toEqual([
      {
        table: "reactions",
        vals: {
          household_id: "hh-1",
          proposal_id: "p1",
          member_id: "m1",
          kind: KIND,
        },
      },
    ]);
    expect(calls.deletes).toEqual([]);
  });

  it("deletes the existing reaction when tapped again (toggle off, idempotent)", async () => {
    const { client, calls } = makeClient({
      existing: { data: { id: "r1" }, error: null },
    });

    const result = await toggleReaction(client, REACT_INPUT);

    expect(result).toEqual({ ok: true, toggled: "off" });
    expect(calls.deletes).toEqual([
      { table: "reactions", column: "id", value: "r1" },
    ]);
    expect(calls.inserts).toEqual([]);
  });

  it("rejects a kind outside the palette before any DB call (untrusted client kind)", async () => {
    const { client, calls } = makeClient({});
    const result = await toggleReaction(client, { ...REACT_INPUT, kind: "💩" });
    expect(result.ok).toBe(false);
    expect(calls.tables).toEqual([]);
  });

  it("rejects a script-injection kind before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await toggleReaction(client, {
      ...REACT_INPUT,
      kind: "<script>alert(1)</script>",
    });
    expect(result.ok).toBe(false);
    expect(calls.tables).toEqual([]);
  });

  it("rejects a missing proposal id before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await toggleReaction(client, { ...REACT_INPUT, proposalId: "" });
    expect(result.ok).toBe(false);
    expect(calls.tables).toEqual([]);
  });

  it("fails closed when the insert errors", async () => {
    const { client } = makeClient({
      existing: { data: null, error: null },
      insertResult: { data: null, error: { message: "boom" } },
    });
    const result = await toggleReaction(client, REACT_INPUT);
    expect(result.ok).toBe(false);
  });
});

describe("addComment", () => {
  const COMMENT_INPUT = {
    householdId: "hh-1",
    proposalId: "p1",
    memberId: "m1",
    body: "  let's do this  ",
  };

  it("inserts a normalized (trimmed) comment body", async () => {
    const { client, calls } = makeClient({
      insertResult: { data: { id: "c1" }, error: null },
    });

    const result = await addComment(client, COMMENT_INPUT);

    expect(result).toEqual({ ok: true, commentId: "c1" });
    expect(calls.inserts).toEqual([
      {
        table: "comments",
        vals: {
          household_id: "hh-1",
          proposal_id: "p1",
          member_id: "m1",
          body: "let's do this",
        },
      },
    ]);
  });

  it("rejects an empty body before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await addComment(client, { ...COMMENT_INPUT, body: "   " });
    expect(result.ok).toBe(false);
    expect(calls.tables).toEqual([]);
  });

  it("rejects a missing proposal id before any DB call", async () => {
    const { client, calls } = makeClient({});
    const result = await addComment(client, { ...COMMENT_INPUT, proposalId: "" });
    expect(result.ok).toBe(false);
    expect(calls.tables).toEqual([]);
  });

  it("fails closed when the insert errors", async () => {
    const { client } = makeClient({
      insertResult: { data: null, error: { message: "boom" } },
    });
    const result = await addComment(client, COMMENT_INPUT);
    expect(result.ok).toBe(false);
  });
});
