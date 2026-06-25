import { describe, expect, it } from "vitest";

import { mergeChange, reconcileByPk, type RealtimeChange } from "./reconcile";

/**
 * Reconcile-by-primary-key — the riskiest logic in the social layer (ADR 0003;
 * SPEC error-handling). Realtime is an ENHANCEMENT, never a correctness
 * dependency: incoming Postgres Changes are merged into local state keyed by PK
 * (so a re-delivered or out-of-order event can never duplicate or lose a row),
 * and on (re)connect a freshly-fetched authoritative snapshot is reconciled by PK
 * (the server is the source of truth — no lost/dup state across a drop).
 */

type Row = { id: string; v: number };

const rows = (...rs: Row[]): Row[] => rs;

describe("mergeChange — incremental Realtime merge by PK", () => {
  it("appends a brand-new INSERT", () => {
    const change: RealtimeChange<Row> = { type: "INSERT", row: { id: "b", v: 2 } };
    expect(mergeChange(rows({ id: "a", v: 1 }), change)).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
  });

  it("is idempotent: a re-delivered INSERT replaces in place, never duplicates", () => {
    const change: RealtimeChange<Row> = { type: "INSERT", row: { id: "a", v: 9 } };
    const out = mergeChange(rows({ id: "a", v: 1 }, { id: "b", v: 2 }), change);
    expect(out).toEqual([
      { id: "a", v: 9 },
      { id: "b", v: 2 },
    ]);
  });

  it("replaces an UPDATE in place, preserving order", () => {
    const change: RealtimeChange<Row> = { type: "UPDATE", row: { id: "a", v: 5 } };
    const out = mergeChange(rows({ id: "a", v: 1 }, { id: "b", v: 2 }), change);
    expect(out).toEqual([
      { id: "a", v: 5 },
      { id: "b", v: 2 },
    ]);
  });

  it("treats an UPDATE for an unknown id as an upsert (a missed INSERT)", () => {
    const change: RealtimeChange<Row> = { type: "UPDATE", row: { id: "z", v: 7 } };
    const out = mergeChange(rows({ id: "a", v: 1 }), change);
    expect(out).toEqual([
      { id: "a", v: 1 },
      { id: "z", v: 7 },
    ]);
  });

  it("removes a DELETE by id", () => {
    const change: RealtimeChange<Row> = { type: "DELETE", id: "a" };
    expect(mergeChange(rows({ id: "a", v: 1 }, { id: "b", v: 2 }), change)).toEqual([
      { id: "b", v: 2 },
    ]);
  });

  it("is a no-op for a DELETE of an unknown / already-removed id (idempotent)", () => {
    const change: RealtimeChange<Row> = { type: "DELETE", id: "gone" };
    expect(mergeChange(rows({ id: "a", v: 1 }), change)).toEqual([{ id: "a", v: 1 }]);
  });

  it("does not mutate the input array", () => {
    const input = rows({ id: "a", v: 1 });
    mergeChange(input, { type: "INSERT", row: { id: "b", v: 2 } });
    expect(input).toEqual([{ id: "a", v: 1 }]);
  });
});

describe("reconcileByPk — authoritative snapshot merge on (re)connect", () => {
  it("returns the snapshot rows, preserving order", () => {
    const snapshot = rows({ id: "a", v: 1 }, { id: "b", v: 2 });
    expect(reconcileByPk(snapshot)).toEqual(snapshot);
  });

  it("dedupes by PK (keeps the first occurrence), so reconnect can't duplicate", () => {
    const snapshot = rows(
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "a", v: 99 },
    );
    const out = reconcileByPk(snapshot);
    // EXPLICIT assumption: the FIRST occurrence wins (v:1), the later dup (v:99)
    // is dropped — the snapshot's stable ordering is preserved.
    expect(out.find((r) => r.id === "a")?.v).toBe(1);
    expect(out).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
  });

  it("handles an empty snapshot", () => {
    expect(reconcileByPk([])).toEqual([]);
  });

  it("returns a new array (does not alias the input)", () => {
    const snapshot = rows({ id: "a", v: 1 });
    expect(reconcileByPk(snapshot)).not.toBe(snapshot);
  });
});
