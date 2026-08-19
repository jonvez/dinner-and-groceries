"use client";

/**
 * The week's shopping list, live across phones (issue #15).
 *
 * Correctness vs. enhancement (ADR 0003; SPEC error-handling) — the same
 * contract as `app/board/proposal-pool.tsx`, whose Realtime plumbing this
 * mirrors deliberately:
 *   - The list is SERVER-rendered (RLS-scoped) and passed in as props, so it is
 *     fully correct with ZERO Realtime. Every edit goes through a Server Action
 *     that `revalidatePath("/grocery")`s, so the actor's own view refreshes via a
 *     normal fetch regardless of the socket.
 *   - Realtime is a pure ENHANCEMENT: one household-scoped channel
 *     (`grocery-list:<householdId>`, `filter: household_id=eq.<householdId>`,
 *     RLS-gated so no cross-household leakage) merges the OTHER shopper's
 *     changes into local state, keyed by PK (`mergeChange`). The week scope is
 *     applied to incoming INSERT/UPDATE rows; a row that arrives already
 *     archived (`purchased_at` set) LEAVES the active list, which is how the
 *     other phone sees "complete trip" happen.
 *   - On a drop + reconnect we ask the SERVER to re-render the authoritative
 *     snapshot (`router.refresh()`), and the `sig`-keyed effect below
 *     `reconcileByPk`s the new props — the server is the source of truth, so
 *     state converges with no lost or duplicated rows. It has to be a server
 *     re-render, NOT a read on the browser client: auth cookies are httpOnly,
 *     so the browser client has no session, and `realtime.setAuth` authenticates
 *     only the SOCKET. A browser-client read runs as anon, RLS denies it, and
 *     the swallowed error would blank the list mid-aisle.
 *   - Toggles apply optimistically and roll back if the action reports an error,
 *     so a tap feels instant in a store with bad signal.
 *
 * The socket is authenticated AS THE SIGNED-IN USER before subscribing
 * (`createRealtimeAuthenticator` + `fetchRealtimeToken`, issue #44/ADR 0008) —
 * the anon-key-only socket would otherwise evaluate RLS as anon and deliver
 * nothing while still reporting "Live". No service-role key exists on any path.
 */

import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/browser";
import {
  createRealtimeAuthenticator,
  fetchRealtimeToken,
} from "@/lib/supabase/realtime-auth";
import {
  mergeChange,
  reconcileByPk,
  type RealtimeChange,
} from "@/lib/social/reconcile";

import {
  addAdHocItemAction,
  addCatalogItemToListAction,
  buildGroceryListAction,
  completeTripAction,
  promoteToCatalogAction,
  setCheckedAction,
  setHaveItAction,
  setItemSectionAction,
  type GroceryActionState,
} from "./actions";
import { toGroceryRow, type CatalogRow, type GroceryRow } from "./list-core";
import { SectionEditor } from "./section-editor";
import { groupBySection, type SectionRow } from "./sections-core";
import type { PromotableItem } from "./trip-core";

export type GroceryListProps = {
  weekId: string;
  householdId: string;
  initialItems: GroceryRow[];
  catalog: CatalogRow[];
  /** The household's aisles, in order. Empty = the list renders ungrouped. */
  sections: SectionRow[];
};

/** Stable signature so a re-render doesn't clobber Realtime-applied state. */
function itemsSig(rows: GroceryRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}:${r.name}:${r.quantity}:${r.unit}:${r.haveIt}:${r.checked}:${r.sectionId}`,
    )
    .join("|");
}

/** Same idea for the aisles, which the editor mutates optimistically. */
function sectionsSig(rows: SectionRow[]): string {
  return rows.map((r) => `${r.id}:${r.name}:${r.position}`).join("|");
}

/** Shopping order: explicit position first, then arrival. */
function sortItems(rows: GroceryRow[]): GroceryRow[] {
  return [...rows].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  );
}

/** "2 cup" / "cup" / "2" / "" — a missing quantity or unit renders as nothing. */
export function formatAmount(
  quantity: number | null,
  unit: string | null,
): string {
  const parts: string[] = [];
  if (quantity !== null && quantity !== undefined) parts.push(String(quantity));
  if (unit) parts.push(unit);
  return parts.join(" ");
}

export function GroceryList({
  weekId,
  householdId,
  initialItems,
  catalog,
  sections: initialSections,
}: GroceryListProps) {
  const [items, setItems] = useState<GroceryRow[]>(() =>
    sortItems(reconcileByPk(initialItems)),
  );
  const [sections, setSections] = useState<SectionRow[]>(initialSections);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<PromotableItem[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  // Held in a ref so the router's identity can never churn the subscription
  // below (a re-JOIN would drop events mid-aisle).
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // Reconcile to the server snapshot whenever it actually changes (i.e. after a
  // revalidate), NOT on every render — otherwise a re-render would undo rows the
  // channel already merged.
  const sig = itemsSig(initialItems);
  useEffect(() => {
    // Sync from the server snapshot (external system), not deriving local
    // render state — the blessed setState-in-effect case per the rule docs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(sortItems(reconcileByPk(initialItems)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // The aisles are edited optimistically below, so they need the same
  // signature-keyed sync as the items: adopt the server's order when it
  // actually changes, and never on a plain re-render.
  const sectionSig = sectionsSig(initialSections);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSections(initialSections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionSig]);

  // ---- Realtime: the other shopper's phone -------------------------------
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (!householdId || !weekId) return;
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const authenticator = createRealtimeAuthenticator({
      getToken: () => fetchRealtimeToken(),
      setAuth: (token) => supabase.realtime.setAuth(token),
    });

    async function setup() {
      // Authenticate FIRST so the channel's JOIN carries the user's JWT.
      await authenticator.start();
      if (cancelled) return;
      channel = subscribe();
    }

    function subscribe() {
      return supabase
        .channel(`grocery-list:${householdId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "grocery_items",
            filter: `household_id=eq.${householdId}`,
          },
          (payload) => {
            const change = toChange(payload, weekId);
            if (change) setItems((prev) => sortItems(mergeChange(prev, change)));
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setLive(true);
            if (wasDisconnected.current) {
              wasDisconnected.current = false;
              // Re-render the RLS-scoped snapshot ON THE SERVER; the sig-keyed
              // effect above reconciles the new props. (A browser-client read
              // would run as anon and blank the list — see the file header.)
              if (!cancelled) routerRef.current.refresh();
            }
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            setLive(false);
            wasDisconnected.current = true;
          }
        });
    }

    void setup();

    return () => {
      cancelled = true;
      authenticator.stop();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [householdId, weekId]);

  // ---- Optimistic toggles -------------------------------------------------
  const patch = useCallback((id: string, values: Partial<GroceryRow>) => {
    setItems((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...values } : row)),
    );
  }, []);

  const onToggleChecked = useCallback(
    async (row: GroceryRow, checked: boolean) => {
      setError(null);
      patch(row.id, { checked });
      const result = await setCheckedAction(row.id, checked);
      if (result && "error" in result) {
        patch(row.id, { checked: row.checked }); // roll back
        setError(result.error);
      }
    },
    [patch],
  );

  const onToggleHaveIt = useCallback(
    async (row: GroceryRow, haveIt: boolean) => {
      setError(null);
      patch(row.id, { haveIt });
      const result = await setHaveItAction(row.id, haveIt);
      if (result && "error" in result) {
        patch(row.id, { haveIt: row.haveIt });
        setError(result.error);
      }
    },
    [patch],
  );

  /**
   * File an item into an aisle. Optimistic like the toggles — the row jumps to
   * its new heading before the write settles, because a shopper mid-aisle on
   * bad signal should never wait to see where something went.
   *
   * The write is DURABLE (`setItemSection` also teaches the staple, #137), so
   * this is "file this permanently", not "nudge it for today" — hence the
   * label on the control below.
   */
  const onMoveToSection = useCallback(
    async (row: GroceryRow, sectionId: string | null) => {
      if (sectionId === row.sectionId) return;
      setError(null);
      patch(row.id, { sectionId });
      const result = await setItemSectionAction(row.id, sectionId);
      if (result && "error" in result) {
        patch(row.id, { sectionId: row.sectionId }); // roll back
        setError(result.error);
      }
    },
    [patch],
  );

  const onAddStaple = useCallback(
    async (catalogItemId: string) => {
      setError(null);
      setBusy(true);
      const result = await addCatalogItemToListAction(weekId, catalogItemId);
      setBusy(false);
      if (result && "error" in result) setError(result.error);
    },
    [weekId],
  );

  const onRebuild = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await buildGroceryListAction(weekId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice(`${result.added} added, ${result.removed} removed.`);
  }, [weekId]);

  const onCompleteTrip = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await completeTripAction(weekId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Archived rows leave the active list immediately (Realtime confirms it on
    // the other phone).
    setItems((prev) => prev.filter((row) => !row.checked));
    setNotice(
      result.archived === 1
        ? "1 item checked off the list."
        : `${result.archived} items checked off the list.`,
    );
    setCandidates(result.promotable);
    setAccepted(
      Object.fromEntries(result.promotable.map((item) => [item.name, true])),
    );
  }, [weekId]);

  const onPromote = useCallback(async () => {
    // Each accepted candidate carries the aisle it was filed into during the
    // trip, so promotion stores the section alongside the staple (#137).
    const names = candidates.filter((item) => accepted[item.name]);
    setError(null);
    setBusy(true);
    const result = await promoteToCatalogAction(names);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCandidates([]);
    setNotice(
      result.promoted === 1
        ? "1 item added to your staples."
        : `${result.promoted} items added to your staples.`,
    );
  }, [candidates, accepted]);

  const remaining = useMemo(
    () => items.filter((row) => !row.checked && !row.haveIt).length,
    [items],
  );

  const groups = useMemo(() => groupBySection(items, sections), [items, sections]);

  return (
    <section aria-label="Shopping list" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">
          Shopping list{" "}
          <span className="text-muted-foreground text-sm font-normal">
            ({remaining} to get)
          </span>
        </h2>
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          data-testid="realtime-status"
        >
          {live ? "Live" : "Live updates paused"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onRebuild()}
          disabled={busy}
          className="border-input rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          Rebuild from menu
        </button>
        <button
          type="button"
          onClick={() => void onCompleteTrip()}
          disabled={busy}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          Complete trip
        </button>
      </div>

      {notice ? (
        <p className="text-muted-foreground text-sm" role="status" data-testid="grocery-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <PromotionPrompt
          candidates={candidates}
          accepted={accepted}
          onToggle={(name, on) =>
            setAccepted((prev) => ({ ...prev, [name]: on }))
          }
          onConfirm={() => void onPromote()}
          onDismiss={() => setCandidates([])}
          busy={busy}
        />
      ) : null}

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing on the list yet — rebuild it from this week&apos;s menu, tap a
          staple, or type something below.
        </p>
      ) : sections.length === 0 ? (
        // No aisles configured (or the read failed): one flat list still beats
        // no list at all in the middle of a store.
        <ul className="space-y-1">
          {items.map((row) => (
            <GroceryItemRow
              key={row.id}
              row={row}
              sections={sections}
              groupId={null}
              onToggleChecked={onToggleChecked}
              onToggleHaveIt={onToggleHaveIt}
              onMoveToSection={onMoveToSection}
            />
          ))}
        </ul>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const headingId = `aisle-${group.id ?? "unsorted"}`;
            return (
              <section
                key={headingId}
                data-testid="section-group"
                data-name={group.name}
                aria-labelledby={headingId}
                className="space-y-1"
              >
                <h3
                  id={headingId}
                  className="bg-background text-muted-foreground sticky top-0 z-10 py-1 text-xs font-semibold tracking-wide uppercase"
                >
                  {group.name}
                </h3>
                <ul className="space-y-1">
                  {group.items.map((row) => (
                    <GroceryItemRow
                      key={row.id}
                      row={row}
                      sections={sections}
                      groupId={group.id}
                      onToggleChecked={onToggleChecked}
                      onToggleHaveIt={onToggleHaveIt}
                      onMoveToSection={onMoveToSection}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <StapleChips catalog={catalog} busy={busy} onAdd={onAddStaple} />
      <AdHocForm weekId={weekId} />
      <SectionEditor sections={sections} onSectionsChange={setSections} />
    </section>
  );
}

/**
 * Map a raw Postgres Changes payload to a PK-keyed change, applying the week
 * scope. A row that arrives ARCHIVED (`purchased_at` set) is treated as a
 * removal — that's how the other shopper's "complete trip" empties this phone's
 * active list. DELETE payloads carry the full old row (REPLICA IDENTITY FULL),
 * but we only need the PK.
 */
export function toChange(
  payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    new: Record<string, unknown>;
    old: Record<string, unknown>;
  },
  weekId: string,
): RealtimeChange<GroceryRow> | null {
  if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (typeof id !== "string") return null;
    return { type: "DELETE", id };
  }

  const row = payload.new as Record<string, unknown>;
  if (typeof row?.id !== "string") return null;
  if (row.week_id !== weekId) return null;
  if (row.purchased_at != null) return { type: "DELETE", id: row.id };

  return {
    type: payload.eventType,
    row: toGroceryRow(row as Parameters<typeof toGroceryRow>[0]),
  };
}

function GroceryItemRow({
  row,
  sections,
  groupId,
  onToggleChecked,
  onToggleHaveIt,
  onMoveToSection,
}: {
  row: GroceryRow;
  sections: SectionRow[];
  /** The aisle this row RENDERED under — see the picker's value below. */
  groupId: string | null;
  onToggleChecked: (row: GroceryRow, checked: boolean) => Promise<void>;
  onToggleHaveIt: (row: GroceryRow, haveIt: boolean) => Promise<void>;
  onMoveToSection: (row: GroceryRow, sectionId: string | null) => Promise<void>;
}) {
  const amount = formatAmount(row.quantity, row.unit);
  const muted = row.haveIt || row.checked;

  return (
    <li
      data-testid="grocery-item"
      data-name={row.name}
      className="border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border p-2 text-left"
    >
      <input
        type="checkbox"
        checked={row.checked}
        aria-label={row.name}
        onChange={(e) => void onToggleChecked(row, e.target.checked)}
        className="size-5 shrink-0"
      />
      <span className={`flex-1 text-sm ${muted ? "text-muted-foreground line-through" : ""}`}>
        <span className="font-medium">{row.name}</span>
        {amount ? (
          <span className="text-muted-foreground ml-2 text-xs tabular-nums">
            {amount}
          </span>
        ) : null}
        {row.ingredientId ? (
          <span className="text-muted-foreground ml-2 text-xs">from the menu</span>
        ) : null}
      </span>
      <button
        type="button"
        aria-pressed={row.haveIt}
        onClick={() => void onToggleHaveIt(row, !row.haveIt)}
        className={`rounded-full border px-2 py-0.5 text-xs ${
          row.haveIt ? "border-primary bg-primary/10" : "border-input"
        }`}
      >
        {row.haveIt ? "Got it already" : "We have it"}
      </button>
      {sections.length > 0 ? (
        // A native <select> on purpose: iOS renders it as a full-width wheel at
        // the bottom of the screen — a thumb-reachable sheet we get for free —
        // and it is keyboard- and screen-reader-complete with nothing to build.
        // Its value is the group the row RENDERED under, not `row.sectionId`,
        // so a pointer at a section this render doesn't know about (deleted on
        // another phone) shows as Unsorted instead of blanking the control.
        <select
          aria-label={`Aisle for ${row.name}`}
          value={groupId ?? ""}
          onChange={(e) =>
            void onMoveToSection(row, e.target.value === "" ? null : e.target.value)
          }
          className="border-input text-muted-foreground basis-full rounded-full border bg-transparent px-2 py-1 text-xs sm:basis-auto"
        >
          {groupId === null ? <option value="">Unsorted</option> : null}
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.name}
            </option>
          ))}
        </select>
      ) : null}
    </li>
  );
}

function StapleChips({
  catalog,
  busy,
  onAdd,
}: {
  catalog: CatalogRow[];
  busy: boolean;
  onAdd: (catalogItemId: string) => Promise<void>;
}) {
  if (catalog.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-muted-foreground text-xs font-medium uppercase">
        Staples
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {catalog.map((staple) => (
          <button
            key={staple.id}
            type="button"
            disabled={busy}
            onClick={() => void onAdd(staple.id)}
            className="border-input rounded-full border px-3 py-1 text-sm disabled:opacity-60"
          >
            + {staple.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function AdHocForm({ weekId }: { weekId: string }) {
  // `weekId` is bound HERE, in a client component, so treat it as client-
  // supplied: the action re-derives `household_id` from the verified session and
  // never trusts this value for authorization. It only narrows a statement RLS
  // has already fenced, and the composite FK `(week_id, household_id) → weeks`
  // makes a row in another household's week literally unstorable (#13).
  const boundAction = addAdHocItemAction.bind(null, weekId);
  const [state, action, pending] = useActionState<GroceryActionState, FormData>(
    boundAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state && "ok" in state) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-medium uppercase">
        Add something else
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label className="sr-only" htmlFor="grocery-name">
            Item
          </label>
          <input
            id="grocery-name"
            name="name"
            maxLength={200}
            required
            placeholder="Paper towels"
            className="border-input bg-background rounded-md border px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="grocery-quantity">
            Quantity (optional)
          </label>
          <input
            id="grocery-quantity"
            name="quantity"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            placeholder="Qty"
            className="border-input bg-background w-20 rounded-md border px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="grocery-unit">
            Unit (optional)
          </label>
          <input
            id="grocery-unit"
            name="unit"
            maxLength={40}
            placeholder="Unit"
            className="border-input bg-background w-24 rounded-md border px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="border-input rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {state && "error" in state ? (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * After a trip, the newly-typed items are OFFERED for the staples catalog —
 * each one toggleable, defaulting to on, and only written when the shopper
 * confirms. Nothing is force-added.
 */
function PromotionPrompt({
  candidates,
  accepted,
  onToggle,
  onConfirm,
  onDismiss,
  busy,
}: {
  candidates: PromotableItem[];
  accepted: Record<string, boolean>;
  onToggle: (name: string, on: boolean) => void;
  onConfirm: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div
      data-testid="promotion-prompt"
      className="border-border space-y-2 rounded-lg border p-3"
    >
      <p className="text-sm font-medium">Add these to your staples?</p>
      <ul className="space-y-1">
        {candidates.map(({ name }) => (
          <li key={name} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              id={`promote-${name}`}
              checked={accepted[name] ?? false}
              onChange={(e) => onToggle(name, e.target.checked)}
              className="size-4"
            />
            <label htmlFor={`promote-${name}`}>{name}</label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          Add to staples
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="border-input rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
