import { describe, expect, it, vi } from "vitest";

import {
  BLANK_SECTION_NAME_ERROR,
  DUPLICATE_SECTION_ERROR,
  createSection,
  deleteSection,
  groupBySection,
  inheritSectionId,
  loadCatalogSectionIndex,
  loadSections,
  renameSection,
  reorderSections,
  resolveSectionId,
} from "./sections-core";

/**
 * Grocery sections (#137) — the aisle grouping. Injected Supabase-like client,
 * asserted at the STATEMENT level, because the payload is the contract that RLS
 * and the composite `(section_id, household_id)` FK are checked against.
 *
 * What's pinned here:
 *   - the read is RLS-first (no household filter) exactly like the catalog read
 *     it sits beside, and takes an explicit fence only on the write paths;
 *   - NULL and the "Unsorted" section mean the same thing, so deleting a
 *     section (which nulls the pointer) never strands an item;
 *   - inheritance matches the way the `(household_id, lower(name))` unique index
 *     does — case-insensitively, on trimmed text;
 *   - reordering writes ONLY `position`, sparsely, so a later single move can be
 *     slotted between two neighbours.
 */

type QueryResult = { data: unknown; error: unknown };
type Filter = { op: string; column: string; value: unknown };

type Recorded = {
  selects: { table: string; columns: string; filters: Filter[]; orders: string[] }[];
  inserts: { table: string; rows: unknown }[];
  updates: { table: string; values: unknown; filters: Filter[] }[];
  deletes: { table: string; filters: Filter[] }[];
};

function makeClient(opts: { rows?: QueryResult; write?: QueryResult } = {}) {
  const calls: Recorded = { selects: [], inserts: [], updates: [], deletes: [] };
  const ok: QueryResult = { data: null, error: null };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const orders: string[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        order(column: string) {
          orders.push(column);
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          calls.selects.push({ table, columns, filters, orders });
          return Promise.resolve(opts.rows ?? { data: [], error: null }).then(resolve);
        },
      };
      return builder;
    },
    insert: (rows: unknown) => {
      calls.inserts.push({ table, rows });
      return Promise.resolve(opts.write ?? ok);
    },
    update: (values: unknown) => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          calls.updates.push({ table, values, filters });
          return Promise.resolve(opts.write ?? ok).then(resolve);
        },
      };
      return builder;
    },
    delete: () => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          calls.deletes.push({ table, filters });
          return Promise.resolve(opts.write ?? ok).then(resolve);
        },
      };
      return builder;
    },
  }));

  const client = { from } as unknown as Parameters<typeof loadSections>[0];
  return { client, calls };
}

const SECTIONS = [
  { id: "s1", name: "Produce", position: 10 },
  { id: "s2", name: "Dairy & Eggs", position: 30 },
  { id: "s9", name: "Unsorted", position: 110 },
];

describe("loadSections", () => {
  it("reads the household's aisles in order, RLS-scoped without an explicit fence", async () => {
    const { client, calls } = makeClient({ rows: { data: SECTIONS, error: null } });

    const sections = await loadSections(client);

    expect(sections).toEqual(SECTIONS);
    expect(calls.selects).toEqual([
      {
        table: "grocery_sections",
        columns: "id, name, position",
        // No household filter: RLS already fences this, exactly as the catalog
        // read in loadGroceryList does.
        filters: [],
        orders: ["position", "name"],
      },
    ]);
  });

  it("takes an explicit household fence when one is supplied (write paths)", async () => {
    const { client, calls } = makeClient({ rows: { data: [], error: null } });

    await loadSections(client, { householdId: "hh-1" });

    expect(calls.selects[0].filters).toEqual([
      { op: "eq", column: "household_id", value: "hh-1" },
    ]);
  });

  it("degrades to an empty list when the read fails (page still renders)", async () => {
    const { client } = makeClient({ rows: { data: null, error: { message: "nope" } } });
    expect(await loadSections(client)).toEqual([]);
  });
});

describe("resolveSectionId", () => {
  it("treats no section as Unsorted, so a deleted aisle never strands an item", () => {
    // The FK is `on delete set null (section_id)`; this is what stops that
    // NULL from becoming an invisible item.
    expect(resolveSectionId(null, SECTIONS)).toBe("s9");
  });

  it("passes an explicit section through untouched", () => {
    expect(resolveSectionId("s2", SECTIONS)).toBe("s2");
  });

  it("returns null when the household has no Unsorted aisle (renamed or deleted)", () => {
    expect(resolveSectionId(null, [SECTIONS[0]])).toBeNull();
  });
});

describe("inheritSectionId", () => {
  const index = new Map([
    ["mozzarella", { id: "c1", sectionId: "sec-dairy" }],
    ["gulfwax", { id: "c2", sectionId: null }],
  ]);

  it("matches case-insensitively on trimmed text, like the unique index", () => {
    expect(inheritSectionId("  Mozzarella ", index)).toBe("sec-dairy");
  });

  it("yields null for a staple that has no aisle yet", () => {
    expect(inheritSectionId("gulfwax", index)).toBeNull();
  });

  it("yields null for an unknown name", () => {
    expect(inheritSectionId("dragonfruit", index)).toBeNull();
  });
});

describe("loadCatalogSectionIndex", () => {
  it("keys the household's catalog by lower(name) in ONE read", async () => {
    const { client, calls } = makeClient({
      rows: {
        data: [
          { id: "c1", name: "Mozzarella", section_id: "sec-dairy" },
          { id: "c2", name: "Olive Oil", section_id: null },
        ],
        error: null,
      },
    });

    const index = await loadCatalogSectionIndex(client, { householdId: "hh-1" });

    expect(index.get("mozzarella")).toEqual({ id: "c1", sectionId: "sec-dairy" });
    expect(index.get("olive oil")).toEqual({ id: "c2", sectionId: null });
    // One round trip for the batch — never one `ilike` per name, which cannot
    // be escaped safely with user-typed text (see the trip-core.ts header).
    expect(calls.selects).toHaveLength(1);
  });
});

describe("createSection", () => {
  it("rejects a blank name before writing anything", async () => {
    const { client, calls } = makeClient();
    expect(await createSection(client, { householdId: "hh-1", name: "   " })).toEqual({
      ok: false,
      error: BLANK_SECTION_NAME_ERROR,
    });
    expect(calls.inserts).toHaveLength(0);
  });

  it("defaults to the END of the order, so a new aisle never lands mid-shop", async () => {
    const { client, calls } = makeClient({ rows: { data: SECTIONS, error: null } });

    await createSection(client, { householdId: "hh-1", name: "Bulk Bins" });

    expect(calls.inserts).toEqual([
      {
        table: "grocery_sections",
        rows: { household_id: "hh-1", name: "Bulk Bins", position: 120 },
      },
    ]);
  });

  it("reports a duplicate name in the family's words, not Postgres's", async () => {
    const { client } = makeClient({ write: { data: null, error: { code: "23505" } } });

    expect(
      await createSection(client, { householdId: "hh-1", name: "Produce", position: 10 }),
    ).toEqual({ ok: false, error: DUPLICATE_SECTION_ERROR });
  });
});

describe("renameSection", () => {
  it("writes ONLY the name — a crafted call can't re-home or reorder the row", async () => {
    const { client, calls } = makeClient();

    await renameSection(client, { id: "s1", name: "  Fruit & Veg  " });

    expect(calls.updates).toEqual([
      {
        table: "grocery_sections",
        values: { name: "Fruit & Veg" },
        filters: [{ op: "eq", column: "id", value: "s1" }],
      },
    ]);
  });

  it("rejects a blank name", async () => {
    const { client, calls } = makeClient();
    expect(await renameSection(client, { id: "s1", name: "" })).toEqual({
      ok: false,
      error: BLANK_SECTION_NAME_ERROR,
    });
    expect(calls.updates).toHaveLength(0);
  });
});

describe("reorderSections", () => {
  it("renumbers SPARSELY so a later single move fits between neighbours", async () => {
    const { client, calls } = makeClient();

    const result = await reorderSections(client, { orderedIds: ["s2", "s9", "s1"] });

    expect(result).toEqual({ ok: true });
    expect(calls.updates).toEqual([
      { table: "grocery_sections", values: { position: 10 }, filters: [{ op: "eq", column: "id", value: "s2" }] },
      { table: "grocery_sections", values: { position: 20 }, filters: [{ op: "eq", column: "id", value: "s9" }] },
      { table: "grocery_sections", values: { position: 30 }, filters: [{ op: "eq", column: "id", value: "s1" }] },
    ]);
  });

  it("ignores blank ids rather than writing a nonsense row", async () => {
    const { client, calls } = makeClient();
    await reorderSections(client, { orderedIds: ["s1", "", "s2"] });
    expect(calls.updates).toHaveLength(2);
  });
});

describe("deleteSection", () => {
  it("deletes only the section — items survive via ON DELETE SET NULL", async () => {
    const { client, calls } = makeClient();

    const result = await deleteSection(client, { id: "s1" });

    expect(result).toEqual({ ok: true });
    expect(calls.deletes).toEqual([
      { table: "grocery_sections", filters: [{ op: "eq", column: "id", value: "s1" }] },
    ]);
    // Nothing touches grocery_items: the shopper's list is never deleted out
    // from under them because an aisle was renamed away.
    expect(calls.updates).toHaveLength(0);
  });
});

describe("groupBySection", () => {
  const sections = [
    { id: "s-produce", name: "Produce", position: 10 },
    { id: "s-dairy", name: "Dairy & Eggs", position: 30 },
    { id: "s-unsorted", name: "Unsorted", position: 110 },
  ];
  const item = (id: string, sectionId: string | null) => ({ id, sectionId });

  it("returns groups in section order, not item order", () => {
    const groups = groupBySection(
      [item("a", "s-dairy"), item("b", "s-produce")],
      sections,
    );

    expect(groups.map((g) => g.name)).toEqual(["Produce", "Dairy & Eggs"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["b"]);
  });

  it("preserves the incoming item order WITHIN a group", () => {
    const groups = groupBySection(
      [item("a", "s-produce"), item("b", "s-produce"), item("c", "s-produce")],
      sections,
    );

    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("hides an empty section — an aisle you aren't buying from is noise", () => {
    const groups = groupBySection([item("a", "s-produce")], sections);

    expect(groups).toHaveLength(1);
    expect(groups.map((g) => g.name)).toEqual(["Produce"]);
  });

  it("files a NULL pointer into Unsorted, which sorts last", () => {
    const groups = groupBySection(
      [item("a", null), item("b", "s-produce")],
      sections,
    );

    expect(groups.map((g) => g.name)).toEqual(["Produce", "Unsorted"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["a"]);
    // Collapsed onto the real section, so the row's picker shows "Unsorted"
    // selected rather than sitting on a phantom id.
    expect(groups[1].id).toBe("s-unsorted");
  });

  it("still renders a NULL pointer when the household has no Unsorted section", () => {
    const groups = groupBySection([item("a", null)], [sections[0]]);

    expect(groups).toEqual([{ id: null, name: "Unsorted", items: [item("a", null)] }]);
  });

  it("never drops an item whose section is unknown to this render", () => {
    // A section deleted on the other phone: our items still carry the old
    // pointer until the next server snapshot arrives. Losing the row mid-aisle
    // would be the worst possible outcome, so it falls back to Unsorted.
    const groups = groupBySection(
      [item("a", "s-vanished"), item("b", "s-produce")],
      sections,
    );

    expect(groups.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(["a", "b"]);
    expect(groups.at(-1)?.name).toBe("Unsorted");
  });

  it("returns one Unsorted group with no sections at all", () => {
    const groups = groupBySection([item("a", null), item("b", "s-x")], []);

    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupBySection([], sections)).toEqual([]);
  });
});
