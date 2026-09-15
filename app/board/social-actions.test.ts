import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Analytics emission at the social Server Actions (issue #210). `social-core`
 * owns the toggle/insert semantics (`social-core.test.ts`); this file pins ONLY
 * what the actions emit:
 *   - `reaction_added` when the toggle turns a reaction ON, and NOTHING when it
 *     turns it off (there is no `reaction_removed` in the taxonomy — inventing
 *     one would be a migration plus an ADR amendment, per ADR 0014),
 *   - one `comment_added` per posted comment, whose payload never carries the
 *     comment body,
 *   - nothing on a rejected/failed action,
 *   - and a broken analytics transport never fails the react/comment.
 *
 * `emitEvent` is NOT mocked — the assertions run over the real inserted row.
 */

type ToggleInput = {
  householdId: string;
  proposalId: string;
  memberId: string;
  kind: string;
};

type CommentInput = ToggleInput & { body: string };

const mocks = vi.hoisted(() => {
  const inserts: { table: string; vals: Record<string, unknown> }[] = [];
  const state = {
    actor: { householdId: "hh-1", memberId: "m-1", weekStartDay: 1 } as
      | { householdId: string; memberId: string; weekStartDay: number }
      | null,
    throwOnInsert: false,
  };
  const client = {
    from: (table: string) => ({
      insert: (vals: Record<string, unknown>) => {
        if (state.throwOnInsert) throw new Error("analytics transport down");
        inserts.push({ table, vals });
        return Promise.resolve({ error: null });
      },
    }),
  };

  return {
    inserts,
    state,
    client,
    toggleReaction: vi.fn<
      (
        input: ToggleInput,
      ) => Promise<
        { ok: true; toggled: "on" | "off" } | { ok: false; error: string }
      >
    >(),
    addComment: vi.fn<
      (
        input: CommentInput,
      ) => Promise<{ ok: true; commentId: string } | { ok: false; error: string }>
    >(),
  };
});

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => mocks.client as never,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./actor", () => ({
  GENERIC_ERROR: "Something went wrong. Reload and try again.",
  resolveActor: async () => mocks.state.actor,
  resolveWeekId: vi.fn(),
}));

vi.mock("./social-core", () => ({
  toggleReaction: (_client: unknown, input: ToggleInput) =>
    mocks.toggleReaction(input),
  addComment: (_client: unknown, input: CommentInput) => mocks.addComment(input),
}));

const { reactAction, addCommentAction } = await import("./social-actions");

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

function emitted() {
  return mocks.inserts
    .filter((row) => row.table === "events")
    .map((row) => row.vals);
}

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.state.actor = { householdId: "hh-1", memberId: "m-1", weekStartDay: 1 };
  mocks.state.throwOnInsert = false;
  mocks.toggleReaction.mockReset().mockResolvedValue({ ok: true, toggled: "on" });
  mocks.addComment.mockReset().mockResolvedValue({ ok: true, commentId: "c-1" });
});

describe("reactAction — reaction_added", () => {
  it("emits one reaction_added when the toggle turns the reaction ON", async () => {
    const result = await reactAction(
      null,
      formData({ proposalId: "p-1", kind: "😋" }),
    );

    expect(result).toEqual({ toggled: "on" });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "reaction_added",
        payload: { proposalId: "p-1", kind: "😋" },
      },
    ]);
  });

  it("emits NOTHING when the toggle turns the reaction off (un-react)", async () => {
    mocks.toggleReaction.mockResolvedValue({ ok: true, toggled: "off" });

    const result = await reactAction(
      null,
      formData({ proposalId: "p-1", kind: "😋" }),
    );

    expect(result).toEqual({ toggled: "off" });
    expect(emitted()).toEqual([]);
  });

  it("emits nothing for an off-palette kind (rejected before any write)", async () => {
    await reactAction(null, formData({ proposalId: "p-1", kind: "not-an-emoji" }));

    expect(emitted()).toEqual([]);
    expect(mocks.toggleReaction).not.toHaveBeenCalled();
  });

  it("emits nothing when the toggle write fails", async () => {
    mocks.toggleReaction.mockResolvedValue({ ok: false, error: "nope" });

    await reactAction(null, formData({ proposalId: "p-1", kind: "😋" }));

    expect(emitted()).toEqual([]);
  });

  it("still reports the toggle when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await reactAction(
      null,
      formData({ proposalId: "p-1", kind: "😋" }),
    );

    expect(result).toEqual({ toggled: "on" });
  });
});

describe("addCommentAction — comment_added", () => {
  it("emits one comment_added with no comment text in the payload", async () => {
    const result = await addCommentAction(
      null,
      formData({ proposalId: "p-1", body: "can we have this on Friday, Ana?" }),
    );

    expect(result).toEqual({ added: true });
    expect(emitted()).toEqual([
      {
        household_id: "hh-1",
        member_id: "m-1",
        event_type: "comment_added",
        payload: { proposalId: "p-1" },
      },
    ]);
    expect(JSON.stringify(emitted()[0].payload)).not.toContain("Friday");
  });

  it("emits nothing when the comment is rejected", async () => {
    mocks.addComment.mockResolvedValue({ ok: false, error: "Say something." });

    await addCommentAction(null, formData({ proposalId: "p-1", body: "   " }));

    expect(emitted()).toEqual([]);
  });

  it("emits nothing when the caller can't be resolved", async () => {
    mocks.state.actor = null;

    await addCommentAction(null, formData({ proposalId: "p-1", body: "hi" }));

    expect(emitted()).toEqual([]);
  });

  it("still succeeds when the analytics insert THROWS", async () => {
    mocks.state.throwOnInsert = true;

    const result = await addCommentAction(
      null,
      formData({ proposalId: "p-1", body: "yes please" }),
    );

    expect(result).toEqual({ added: true });
  });
});
