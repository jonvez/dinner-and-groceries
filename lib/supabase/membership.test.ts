import { describe, expect, it, vi } from "vitest";

import { userHasMember } from "./membership";

function clientReturning(result: {
  data: unknown;
  error: unknown;
}) {
  const maybeSingle = vi.fn(async () => result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from, _eq: eq } as any;
}

describe("userHasMember", () => {
  it("is true when a members row exists for the user", async () => {
    const client = clientReturning({ data: { id: "m1" }, error: null });
    await expect(userHasMember(client, "u1")).resolves.toBe(true);
  });

  it("is false when no members row exists", async () => {
    const client = clientReturning({ data: null, error: null });
    await expect(userHasMember(client, "u1")).resolves.toBe(false);
  });

  it("constrains the query to the given user id", async () => {
    const client = clientReturning({ data: null, error: null });
    await userHasMember(client, "user-99");
    expect(client._eq).toHaveBeenCalledWith("user_id", "user-99");
  });

  it("fails CLOSED on a query error (treated as no membership)", async () => {
    const client = clientReturning({
      data: null,
      error: { message: "boom" },
    });
    await expect(userHasMember(client, "u1")).resolves.toBe(false);
  });
});
