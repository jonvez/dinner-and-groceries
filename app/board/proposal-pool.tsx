"use client";

/**
 * The week's shared idea pool with its SOCIAL layer (issue #9): the proposals
 * themselves plus emoji reactions and comments on each, pushed live via Supabase
 * Realtime — with graceful degradation when Realtime drops.
 *
 * Correctness vs. enhancement (ADR 0003; SPEC error-handling):
 *   - The initial proposals/reactions/comments are server-rendered (RLS-scoped)
 *     and passed in as props, so the pool is fully correct with ZERO Realtime.
 *     Acting on a proposal goes through a server action that `revalidatePath`s the
 *     board, so the actor's own view refreshes via a normal fetch regardless of
 *     Realtime.
 *   - Realtime is a pure ENHANCEMENT: a single channel (filtered by household_id —
 *     a real column — and RLS-gated, so no cross-household leakage) merges other
 *     members' changes into local state, keyed by PK (`mergeChange`). The week
 *     scope ("filtered by week_id" — reactions/comments carry no week_id column,
 *     so we scope by the week's proposal ids) is applied to incoming INSERT/UPDATE
 *     rows; DELETEs are applied by PK and are naturally week-scoped because local
 *     state only ever holds this week's rows.
 *   - `proposals` themselves (issue #64, ADR 0013) are bound on the SAME channel,
 *     filtered by `week_id` (a real column on the row — the precise scope; RLS
 *     still enforces the household). A proposals change is a TRIGGER, not a
 *     payload to render: the payload carries the table's own columns only, with
 *     no dish title and no proposer name — both come from server-side joins
 *     (app/board/page.tsx) — so rendering it would flash "Untitled dish". Instead
 *     we `router.refresh()`, the server re-renders the authoritative joined
 *     snapshot, and the sig-keyed effect below reconciles it by PK. Bursts
 *     coalesce (lib/social/refresh-coalescer.ts) so a flurry of ideas can't storm
 *     the server.
 *   - The subscription effect depends on STABLE IDS ONLY (`householdId`,
 *     `weekId`). It used to be keyed on the proposal-id list, so every proposal
 *     tore the channel down and re-JOINed through the blind window documented
 *     below — unacceptable once proposals arrive live. The week's proposal ids,
 *     which scope incoming reactions/comments, are therefore read from a REF.
 *   - On a drop + reconnect we ask the SERVER to re-render the authoritative
 *     snapshot (`router.refresh()`), and the sig-keyed effect below
 *     `reconcileByPk`s the new props — the server is the source of truth, so
 *     state converges with no lost or duplicated rows. It has to be a server
 *     re-render, NOT a read on the browser client: auth cookies are httpOnly
 *     (ADR 0008), so the browser client has no session, and `realtime.setAuth`
 *     authenticates only the SOCKET. A browser-client read runs as anon, RLS
 *     denies it (42501), and the swallowed error would blank the board
 *     (issue #114).
 *
 * The socket is authenticated AS THE SIGNED-IN USER before subscribing
 * (`createRealtimeAuthenticator` + `fetchRealtimeToken`, issue #44/ADR 0008).
 * If no token could be applied the channel still JOINs (it only needs the
 * apikey) but RLS delivers nothing — so the status says "Live updates paused"
 * rather than lying about being live. No service-role key exists on any path.
 */

import { useRouter } from "next/navigation";
import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
import {
  createServerRefreshCoalescer,
  type ServerRefreshCoalescer,
} from "@/lib/social/refresh-coalescer";
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
  /** The viewed week's row id — the Realtime scope for `proposals` (#64). */
  weekId: string;
  currentMemberId: string;
  /** The viewed week's start (YYYY-MM-DD) — the slot target for tap-to-slot. */
  weekStart: string;
  /** Household week-start day, for ordering the day picker (Monday=1 default). */
  weekStartDay?: number;
  /** The server's joined, RLS-scoped snapshot — seeds state, see `proposalsSig`. */
  initialProposals: ProposalView[];
  initialReactions: ReactionRow[];
  initialComments: CommentRow[];
  /** member id -> display name, for attributing comments that arrive live. */
  memberNames: Record<string, string>;
};

// Stable signatures so the prop->state reconcile effect only fires when the
// server snapshot actually changed (e.g. after a revalidatePath), not on every
// render (which would clobber Realtime-applied local state).
function proposalsSig(rows: ProposalView[]): string {
  return rows
    .map(
      (p) =>
        `${p.id}:${p.title}:${p.note ?? ""}:${p.sourceUrl ?? ""}:${p.proposerName ?? ""}:${p.createdAt}`,
    )
    .join("|");
}
function reactionsSig(rows: ReactionRow[]): string {
  return rows.map((r) => `${r.id}:${r.proposal_id}:${r.member_id}:${r.kind}`).join("|");
}
function commentsSig(rows: CommentRow[]): string {
  return rows.map((r) => `${r.id}:${r.body}`).join("|");
}

export function ProposalPool({
  householdId,
  weekId,
  currentMemberId,
  weekStart,
  weekStartDay = 1,
  initialProposals,
  initialReactions,
  initialComments,
  memberNames,
}: ProposalPoolProps) {
  // Proposals are STATE, not a raw prop (#64): the sig-keyed effect below is what
  // applies a refreshed server snapshot without clobbering the rest of the board.
  const [proposals, setProposals] = useState<ProposalView[]>(() =>
    reconcileByPk(initialProposals),
  );
  const [reactions, setReactions] = useState<ReactionRow[]>(() =>
    reconcileByPk(initialReactions),
  );
  const [comments, setComments] = useState<CommentRow[]>(() =>
    reconcileByPk(initialComments),
  );
  const [live, setLive] = useState(false);
  // An anon socket JOINs fine but RLS delivers nothing (#44), so "Live" means
  // BOTH subscribed and authenticated as the signed-in user.
  const [socketAuthed, setSocketAuthed] = useState(false);

  // Held in a ref so the router's identity can never churn the subscription
  // below (a re-JOIN would drop events).
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  /**
   * "Something changed → ask the SERVER to re-render" (#64/ADR 0013 §2), with at
   * most one round trip in flight so a flurry of ideas can't storm the server.
   * Built once on mount (it reads the router ref, so it must not be constructed
   * during render) and torn down with the component.
   */
  const refresherRef = useRef<ServerRefreshCoalescer | null>(null);
  useEffect(() => {
    const refresher = createServerRefreshCoalescer({
      refresh: () => routerRef.current.refresh(),
    });
    refresherRef.current = refresher;
    return () => {
      refresher.stop();
      refresherRef.current = null;
    };
  }, []);
  /** Ask for a server re-render (a no-op before mount — nothing is in flight). */
  const requestRefresh = useCallback(() => {
    refresherRef.current?.request();
  }, []);

  const proposalIds = useMemo(
    () => new Set(proposals.map((p) => p.id)),
    [proposals],
  );
  // Read by the reactions/comments handlers to apply the week scope. A REF, so
  // the subscription below never depends on the proposal set — the whole point
  // of #64's third defect (a re-JOIN per proposal, through the blind window).
  // A reaction for a proposal that arrived live but whose snapshot hasn't landed
  // yet is dropped here and then comes in WITH that snapshot, so nothing is lost.
  const proposalIdsRef = useRef(proposalIds);
  useEffect(() => {
    proposalIdsRef.current = proposalIds;
  }, [proposalIds]);

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
  const pSig = proposalsSig(initialProposals);
  const rSig = reactionsSig(initialReactions);
  const cSig = commentsSig(initialComments);
  useEffect(() => {
    // Sync from the server snapshot (external system), not deriving local
    // render state — the blessed setState-in-effect case per the rule docs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProposals(reconcileByPk(initialProposals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pSig]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReactions(reconcileByPk(initialReactions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rSig]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setComments(reconcileByPk(initialComments));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cSig]);

  // A fresh server snapshot landed, so the refresh it answered is done: release
  // the coalescer (and pay the single follow-up owed to anything that arrived
  // while that round trip was in flight).
  useEffect(() => {
    refresherRef.current?.settled();
  }, [pSig, rSig, cSig]);

  // Single Realtime channel for the week's social signals.
  const wasDisconnected = useRef(false);
  useEffect(() => {
    // Note what is NOT here: the proposal set. A week with ZERO proposals still
    // needs a channel, or the FIRST idea of the week could never arrive live.
    if (!householdId || !weekId) return;
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

    async function setup() {
      // Known gap (reviewed, accepted): between an old channel leaving and this
      // one subscribing, no channel exists, so a drop that both starts AND
      // recovers inside this token round trip goes unobserved. Inherent to
      // re-subscribing — nothing is listening in that window either way — and
      // narrow: a deps change is itself caused by a fresh server render, so the
      // props are authoritative as of microseconds earlier, and a socket still
      // down when we subscribe times out, sets the flag, and refreshes on
      // recovery.
      // Authenticate first so the channel's initial JOIN carries the user's JWT.
      const authed = await authenticator.start();
      if (cancelled) return;
      setSocketAuthed(authed);
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
            table: "proposals",
            // `week_id` IS a column on proposals, so this is the precise scope
            // (another week's activity must not refresh this page). RLS still
            // enforces the household on every delivery.
            filter: `week_id=eq.${weekId}`,
          },
          () => {
            // Deliberately ignoring the payload: it has no joined dish title or
            // proposer name, so it is a trigger only. The server re-renders the
            // snapshot; the sig-keyed effect above reconciles it by PK. NEVER a
            // browser-client read (anon => RLS denial => blank board, #114).
            requestRefresh();
          },
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "reactions",
            filter: `household_id=eq.${householdId}`,
          },
          (payload) => {
            const change = toChange<ReactionRow>(payload, proposalIdsRef.current);
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
            const change = toChange<CommentRow>(payload, proposalIdsRef.current);
            if (change) setComments((prev) => mergeChange(prev, change));
          },
        )
        .subscribe((status) => {
          // A torn-down channel still reports CLOSED as it goes. That is US
          // closing it (a re-subscribe after the viewed WEEK changed — since #64
          // nothing else churns these deps), not the network dropping — so this
          // effect's channel must go quiet the moment it is cancelled, or the
          // replacement channel would read the shared `wasDisconnected` flag as a
          // reconnect and refresh for nothing.
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setLive(true);
            if (wasDisconnected.current) {
              wasDisconnected.current = false;
              // Re-render the RLS-scoped snapshot ON THE SERVER; the sig-keyed
              // effect above reconciles the new props. (A browser-client read
              // would run as anon and blank the board — see the file header.)
              // Through the same coalescer as the proposals trigger: ONE refresh
              // path, so a reconnect during a burst doesn't double up.
              requestRefresh();
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
    // STABLE IDS ONLY (#64): a proposal arriving must not tear the channel down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, weekId]);

  return (
    <section aria-label="This week's ideas" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">This week&apos;s ideas</h2>
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          data-testid="realtime-status"
        >
          {live && socketAuthed ? "Live" : "Live updates paused"}
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
