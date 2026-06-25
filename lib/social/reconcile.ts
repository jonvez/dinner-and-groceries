/**
 * Reconcile-by-primary-key — the correctness core that lets Realtime be a pure
 * ENHANCEMENT (ADR 0003; SPEC error-handling: "Realtime drops → board still works
 * via normal fetches; reactions/comments reconcile on reconnect").
 *
 * Two operations, both keyed by the row PK so duplicate, out-of-order, or missed
 * events can never corrupt local state:
 *
 *   - `mergeChange`: apply ONE incoming Postgres Changes event to local state.
 *     INSERT/UPDATE upsert by id (a re-delivered INSERT replaces rather than
 *     duplicates; an UPDATE for an unseen id fills a missed INSERT). DELETE removes
 *     by id (a no-op if already gone). Idempotent under replay.
 *
 *   - `reconcileByPk`: on (re)connect, fold a freshly-FETCHED authoritative
 *     snapshot into a deduped list. The server is the source of truth, so a drop +
 *     reconnect converges on exactly the server's rows — no lost or duplicated
 *     state, regardless of what happened while disconnected.
 *
 * Generic over any `{ id: string }` row, so reactions and comments share it.
 */

export type Identified = { id: string };

export type RealtimeChange<T extends Identified> =
  | { type: "INSERT"; row: T }
  | { type: "UPDATE"; row: T }
  | { type: "DELETE"; id: string };

export function mergeChange<T extends Identified>(
  rows: readonly T[],
  change: RealtimeChange<T>,
): T[] {
  if (change.type === "DELETE") {
    return rows.filter((r) => r.id !== change.id);
  }

  // INSERT or UPDATE: upsert by PK. Replace in place if present (preserves order
  // and de-dupes re-delivered events); otherwise append.
  const next = rows.slice();
  const index = next.findIndex((r) => r.id === change.row.id);
  if (index === -1) {
    next.push(change.row);
  } else {
    next[index] = change.row;
  }
  return next;
}

export function reconcileByPk<T extends Identified>(snapshot: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of snapshot) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
