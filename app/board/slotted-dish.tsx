"use client";

/**
 * A single dish slotted into a board cell, with its tap-to-unslot control
 * (issue #10). Reversibility is the requirement: tapping the × removes exactly
 * this slot_dishes row via the server action; re-slotting and swapping are just
 * further slot/unslot taps. No drag-and-drop (post-MVP — ADR 0003).
 *
 * Kept a small client component so the grid itself stays server-rendered; the
 * unslot orchestration lives in slot-core (unit-tested) behind the action.
 */

import { useActionState } from "react";

import { unslotDishAction, type UnslotState } from "./slot-actions";

export function SlottedDishChip({
  slotDishId,
  title,
}: {
  slotDishId: string;
  title: string;
}) {
  const [, action, pending] = useActionState<UnslotState, FormData>(
    unslotDishAction,
    null,
  );

  return (
    <form
      action={action}
      className="bg-background flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-xs"
    >
      <input type="hidden" name="slotDishId" value={slotDishId} readOnly />
      <span className="truncate">{title}</span>
      <button
        type="submit"
        disabled={pending}
        aria-label={`Unslot ${title}`}
        className="text-muted-foreground hover:text-destructive shrink-0 leading-none disabled:opacity-60"
      >
        <span aria-hidden>×</span>
      </button>
    </form>
  );
}
