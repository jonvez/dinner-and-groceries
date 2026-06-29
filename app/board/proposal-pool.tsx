"use client";

/**
 * The week's shared idea pool with its SOCIAL layer (issue #9): emoji reactions
 * and comments on each proposal, pushed live via Supabase Realtime — with
 * graceful degradation when Realtime drops.
 *
 * Correctness vs. enhancement (ADR 0003; SPEC error-handling):
 *   - The initial reactions/comments are server-rendered (RLS-scoped) and passed
 *     in as props, so the pool is fully correct with ZERO Realtime. Acting on a
 *     proposal goes through a server action that `revalidatePath`s the board, so
 *     the actor's own view refreshes via a normal fetch regardless of Realtime.
 *   - Realtime is a pure ENHANCEMENT: a single channel (filtered by household_id —
 *     a real column — and RLS-gated, so no cross-household leakage) merges other
 *     members' changes into local state, keyed by PK (`mergeChange`). The week
 *     scope ("filtered by week_id" — reactions/comments carry no week_id column,
 *     so we scope by the week's proposal ids) is applied to incoming INSERT/UPDATE
 *     rows; DELETEs are applied by PK and are naturally week-scoped because local
 *     state only ever holds this week's rows.
 *   - On a drop + reconnect, we re-FETCH the authoritative snapshot and
 *     `reconcileByPk` — the server is the source of truth, so state converges with
 *     no lost or duplicated rows.
 */

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/browser";
import {
  createRealtimeAuthenticator,
  fetchRealtimeToken,
} from "@/lib/supabase/realtime-auth";
import { isReadyToSlot, nudgeSort } from "@/lib/social/nudge";
import { tallyReactions } from "@/lib/social/reactions";
import {
  mergeChange,
  reconcileByPk,
  type RealtimeChange,
} from "@/lib/social/reconcile";
import { safeHttpUrl } from "@/lib/web/safe-url";
import { orderedDayOfWeek } from "@/lib/week/boundary";
import { DAY_SHORT_NAMES, MEAL_TYPES, mealTypeLabel } from "@/lib/week/labels";

import {
  addCommentAction,
  reactAction,
  type CommentState,
  type ReactState,
} from "./social-actions";
import { slotDishAction, type SlotState } from "./slot-actions";

export type ProposalView = {
  id: string;
  /** The library dish this proposal points at — the thing that gets slotted. */
  dishId: string;
  /** ISO timestamp; the nudge-sort tiebreaker (most-recent first). */
  createdAt: string;
  title: string;
  note: string | null;
  sourceUrl: string | null;
  proposerName: string | null;
};

export type ReactionRow = {
  id: string;
  proposal_id: string;
  member_id: string;
  kind: string;
};

export type CommentRow = {
  id: string;
  proposal_id: string;
  member_id: string | null;
  body: string;
  created_at: string;
};

export type ProposalPoolProps = {
  householdId: string;
  currentMemberId: string;
  /** The viewed week's start (YYYY-MM-DD) — the slot target for tap-to-slot. */
  weekStart: string;
  /** Household week-start day, for ordering the day picker (Monday=1 default). */
  weekStartDay?: number;
  proposals: ProposalView[];
  initialReactions: ReactionRow[];
  initialComments: CommentRow[];
  /** member id -> display name, for attributing comments that arrive live. */
  memberNames: Record<string, string>;
};

// Stable signatures so the prop->state reconcile effect only fires when the
// server snapshot actually changed (e.g. after a revalidatePath), not on every
// render (which would clobber Realtime-applied local state).
function reactionsSig(rows: ReactionRow[]): string {
  return rows.map((r) => `${r.id}:${r.proposal_id}:${r.member_id}:${r.kind}`).join("|");
}
function commentsSig(rows: CommentRow[]): string {
  return rows.map((r) => `${r.id}:${r.body}`).join("|");
}

export function ProposalPool({
  householdId,
  currentMemberId,
  weekStart,
  weekStartDay = 1,
  proposals,
  initialReactions,
  initialComments,
  memberNames,
}: ProposalPoolProps) {
  const [reactions, setReactions] = useState<ReactionRow[]>(() =>
    reconcileByPk(initialReactions),
  );
  const [comments, setComments] = useState<CommentRow[]>(() =>
    reconcileByPk(initialComments),
  );
  const [live, setLive] = useState(false);

  const proposalIds = useMemo(
    () => new Set(proposals.map((p) => p.id)),
    [proposals],
  );
  const proposalIdList = useMemo(() => proposals.map((p) => p.id), [proposals]);

  // Nudge sort: attach each proposal's CURRENT reactions (server snapshot +
  // any live merges) and order by positive-reaction count desc, tiebreak
  // most-recent. This only re-orders the pool to GUIDE attention — it never
  // auto-slots anything (a human still taps to slot). Recomputed when reactions
  // change so a fresh thumbs-up can float a dish up live.
  const ordered = useMemo(() => {
    const withReactions = proposals.map((p) => ({
      ...p,
      reactions: reactions.filter((r) => r.proposal_id === p.id),
    }));
    return nudgeSort(withReactions);
  }, [proposals, reactions]);

  // Reconcile to the server snapshot whenever it changes (post-revalidate). The
  // snapshot is authoritative; Realtime-applied local rows that are also in the
  // snapshot reconcile by PK (no dup), and any not yet in it re-arrive via the
  // channel. Keyed by signature so Realtime updates don't trigger a reset.
  const rSig = reactionsSig(initialReactions);
  const cSig = commentsSig(initialComments);
  useEffect(() => {
    setReactions(reconcileByPk(initialReactions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rSig]);
  useEffect(() => {
    setComments(reconcileByPk(initialComments));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cSig]);

  // Single Realtime channel for the week's social signals.
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (proposalIdList.length === 0) return;
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Authenticate the Realtime socket AS THE SIGNED-IN USER (issue #44). The
    // browser `@supabase/ssr` client builds the websocket with the anon key only
    // — our session tokens live in httpOnly cookies, unreadable from JS — so
    // without this the RLS-gated postgres_changes on reactions/comments evaluate
    // as anon and deliver NOTHING (the channel still JOINs, which is why the UI
    // showed "Live" while no events arrived). We fetch the short-lived access
    // token from a same-origin server route and apply it BEFORE subscribing, then
    // keep it fresh ahead of expiry. The refresh token never leaves the server.
    const authenticator = createRealtimeAuthenticator({
      getToken: () => fetchRealtimeToken(),
      setAuth: (token) => supabase.realtime.setAuth(token),
    });

    // Pull the authoritative snapshot after a (re)connect: the server is truth,
    // so a drop + reconnect converges with no lost/dup state (reconcileByPk).
    async function refetch() {
      const { data: rx } = await supabase
        .from("reactions")
        .select("id, proposal_id, member_id, kind")
        .in("proposal_id", proposalIdList);
      if (rx) setReactions(reconcileByPk(rx as ReactionRow[]));

      const { data: cm } = await supabase
        .from("comments")
        .select("id, proposal_id, member_id, body, created_at")
        .in("proposal_id", proposalIdList)
        .order("created_at", { ascending: true });
      if (cm) setComments(reconcileByPk(cm as CommentRow[]));
    }

    async function setup() {
      // Authenticate first so the channel's initial JOIN carries the user's JWT.
      await authenticator.start();
      if (cancelled) return;
      channel = subscribe();
    }

    function subscribe() {
      return supabase
        .channel(`board-social:${householdId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "reactions",
            filter: `household_id=eq.${householdId}`,
          },
          (payload) => {
            const change = toChange<ReactionRow>(payload, proposalIds);
            if (change) setReactions((prev) => mergeChange(prev, change));
          },
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "comments",
            filter: `household_id=eq.${householdId}`,
          },
          (payload) => {
            const change = toChange<CommentRow>(payload, proposalIds);
            if (change) setComments((prev) => mergeChange(prev, change));
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setLive(true);
            if (wasDisconnected.current) {
              wasDisconnected.current = false;
              void refetch();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, proposalIdList.join(",")]);

  return (
    <section aria-label="This week's ideas" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">This week&apos;s ideas</h2>
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          data-testid="realtime-status"
        >
          {live ? "Live" : "Live updates paused"}
        </span>
      </div>

      {ordered.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No ideas yet — be the first to propose a dish for this week.
        </p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              currentMemberId={currentMemberId}
              weekStart={weekStart}
              weekStartDay={weekStartDay}
              reactions={p.reactions}
              comments={comments.filter((c) => c.proposal_id === p.id)}
              memberNames={memberNames}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Map a raw Postgres Changes payload to a PK-keyed RealtimeChange, applying the
 * week scope. INSERT/UPDATE rows carry `proposal_id`, so they're dropped unless
 * they belong to a proposal in this week. DELETE payloads (default replica
 * identity) carry only the PK — they're applied unconditionally and are a no-op
 * unless the id is in local state, which only ever holds this week's rows.
 */
function toChange<T extends { id: string }>(
  payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    new: Record<string, unknown>;
    old: Record<string, unknown>;
  },
  proposalIds: Set<string>,
): RealtimeChange<T> | null {
  if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (typeof id !== "string") return null;
    return { type: "DELETE", id };
  }
  const row = payload.new as T & { proposal_id?: string };
  if (!row?.id || !proposalIds.has(row.proposal_id ?? "")) return null;
  return { type: payload.eventType, row };
}

function ProposalCard({
  proposal: p,
  currentMemberId,
  weekStart,
  weekStartDay,
  reactions,
  comments,
  memberNames,
}: {
  proposal: ProposalView;
  currentMemberId: string;
  weekStart: string;
  weekStartDay: number;
  reactions: ReactionRow[];
  comments: CommentRow[];
  memberNames: Record<string, string>;
}) {
  // Defense in depth: re-validate the stored recipe URL before rendering an href
  // (React does not block dangerous schemes; a pre-guard row could exist).
  const href = safeHttpUrl(p.sourceUrl);
  // The badge is a derived NUDGE only: it tells a human this dish has broad
  // support (>=2 distinct positive reactors). It never slots anything itself.
  const ready = isReadyToSlot(reactions);

  return (
    <li className="border-border space-y-3 rounded-lg border p-3 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium" data-testid="proposal-title">
          {p.title}
        </span>
        {p.proposerName ? (
          <span className="text-muted-foreground text-xs">
            proposed by {p.proposerName}
          </span>
        ) : null}
      </div>
      {ready ? (
        <span className="bg-primary/10 text-primary inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium">
          Ready to slot
        </span>
      ) : null}
      {p.note ? (
        <p className="text-muted-foreground text-sm">{p.note}</p>
      ) : null}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary inline-block text-xs underline underline-offset-4"
        >
          View recipe
        </a>
      ) : null}

      <ReactionBar
        proposalId={p.id}
        reactions={reactions}
        currentMemberId={currentMemberId}
      />
      <SlotControl
        dishId={p.dishId}
        proposalId={p.id}
        weekStart={weekStart}
        weekStartDay={weekStartDay}
      />
      <CommentThread comments={comments} memberNames={memberNames} />
      <CommentForm proposalId={p.id} />
    </li>
  );
}

/**
 * Tap-to-slot affordance: pick a day + meal-type and slot this proposal's dish
 * onto the board. A deliberate human action — the badge/sort only guide it. The
 * day + meal-type are validated server-side (untrusted); identity + week come
 * from the verified session in the action. No drag-and-drop (post-MVP).
 */
function SlotControl({
  dishId,
  proposalId,
  weekStart,
  weekStartDay,
}: {
  dishId: string;
  proposalId: string;
  weekStart: string;
  weekStartDay: number;
}) {
  const [state, action, pending] = useActionState<SlotState, FormData>(
    slotDishAction,
    null,
  );
  const dayIds = orderedDayOfWeek(weekStartDay);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="dishId" value={dishId} readOnly />
      <input type="hidden" name="weekStart" value={weekStart} readOnly />

      <label className="sr-only" htmlFor={`slot-day-${proposalId}`}>
        Day
      </label>
      <select
        id={`slot-day-${proposalId}`}
        name="dayOfWeek"
        defaultValue=""
        className="border-input bg-background rounded-md border px-2 py-1 text-sm"
      >
        <option value="" disabled>
          Day…
        </option>
        {dayIds.map((dow) => (
          <option key={dow} value={dow}>
            {DAY_SHORT_NAMES[dow]}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor={`slot-meal-${proposalId}`}>
        Meal
      </label>
      <select
        id={`slot-meal-${proposalId}`}
        name="mealType"
        defaultValue="dinner"
        className="border-input bg-background rounded-md border px-2 py-1 text-sm"
      >
        {MEAL_TYPES.map((mealType) => (
          <option key={mealType} value={mealType}>
            {mealTypeLabel(mealType)}
          </option>
        ))}
      </select>

      <button
        type="submit"
        disabled={pending}
        className="border-input rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Slotting…" : "Slot it"}
      </button>

      {state && "error" in state ? (
        <p role="alert" className="text-destructive w-full text-xs">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function ReactionBar({
  proposalId,
  reactions,
  currentMemberId,
}: {
  proposalId: string;
  reactions: ReactionRow[];
  currentMemberId: string;
}) {
  const [, action, pending] = useActionState<ReactState, FormData>(
    reactAction,
    null,
  );
  const tally = tallyReactions(reactions, currentMemberId);

  return (
    <form action={action} className="flex flex-wrap gap-1.5">
      <input type="hidden" name="proposalId" value={proposalId} readOnly />
      {tally.map(({ kind, count, mine }) => (
        <button
          key={kind}
          type="submit"
          name="kind"
          value={kind}
          disabled={pending}
          aria-pressed={mine}
          aria-label={`React ${kind}${count ? ` (${count})` : ""}`}
          className={`rounded-full border px-2 py-0.5 text-sm disabled:opacity-60 ${
            mine ? "border-primary bg-primary/10" : "border-input"
          }`}
        >
          <span aria-hidden>{kind}</span>
          {count > 0 ? (
            <span className="ml-1 text-xs tabular-nums">{count}</span>
          ) : null}
        </button>
      ))}
    </form>
  );
}

function CommentThread({
  comments,
  memberNames,
}: {
  comments: CommentRow[];
  memberNames: Record<string, string>;
}) {
  if (comments.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label="Comments">
      {comments.map((c) => {
        const author =
          (c.member_id && memberNames[c.member_id]) || "Someone";
        return (
          <li key={c.id} className="text-sm">
            <span className="font-medium">{author}</span>{" "}
            <time
              dateTime={c.created_at}
              className="text-muted-foreground text-xs"
            >
              {formatTimestamp(c.created_at)}
            </time>
            {/* React escapes this by default — no dangerouslySetInnerHTML. */}
            <p className="text-foreground">{c.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

function CommentForm({ proposalId }: { proposalId: string }) {
  const [state, action, pending] = useActionState<CommentState, FormData>(
    addCommentAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state && "added" in state) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="proposalId" value={proposalId} readOnly />
      <label className="sr-only" htmlFor={`comment-${proposalId}`}>
        Add a comment
      </label>
      <div className="flex gap-2">
        <input
          id={`comment-${proposalId}`}
          name="body"
          maxLength={1000}
          placeholder="Add a comment…"
          className="border-input bg-background flex-1 rounded-md border px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "…" : "Post"}
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

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
