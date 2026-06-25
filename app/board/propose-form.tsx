"use client";

/**
 * Propose a dish for the viewed week (issue #8). Two paths, mirroring Flow A:
 *   - NEW dish: title + optional recipe URL + optional note. A recipe URL is
 *     just stored as a string (no ingestion — that's slice 1c).
 *   - RECYCLE ("propose again"): pick an existing library dish; only a new
 *     proposal is created (no dish duplication). Hidden when the library is
 *     empty (nothing to recycle yet).
 *
 * Both submit the viewed `weekStart` (hidden) so the proposal lands on the week
 * the user is looking at — past/future included (no lock, ADR 0003). Identity is
 * resolved server-side from the session, never from these inputs.
 */

import { useActionState } from "react";

import {
  proposeNewDishAction,
  recycleDishAction,
  type ProposeState,
} from "./actions";

export type LibraryDish = { id: string; title: string };

export type ProposeFormProps = {
  weekStart: string;
  libraryDishes: LibraryDish[];
};

function Feedback({ state }: { state: ProposeState }) {
  if (state === null) return null;
  if ("added" in state) {
    return (
      <p role="status" className="text-sm text-emerald-600">
        Added to the week.
      </p>
    );
  }
  return (
    <p role="alert" className="text-destructive text-sm">
      {state.error}
    </p>
  );
}

export function ProposeForm({ weekStart, libraryDishes }: ProposeFormProps) {
  const [newState, newAction, newPending] = useActionState<ProposeState, FormData>(
    proposeNewDishAction,
    null,
  );
  const [recycleState, recycleAction, recyclePending] = useActionState<
    ProposeState,
    FormData
  >(recycleDishAction, null);

  const inputClass =
    "border-input bg-background rounded-md border px-3 py-2 text-sm";
  const buttonClass =
    "bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60";

  return (
    <div className="space-y-6">
      <form action={newAction} className="flex flex-col gap-3 text-left">
        <h3 className="font-medium">Propose a new dish</h3>
        <input type="hidden" name="weekStart" value={weekStart} readOnly />

        <label className="text-sm font-medium" htmlFor="propose-title">
          Dish title
        </label>
        <input
          id="propose-title"
          name="title"
          required
          maxLength={200}
          placeholder="Carnitas tacos"
          className={inputClass}
        />

        <label className="text-sm font-medium" htmlFor="propose-url">
          Recipe URL (optional)
        </label>
        <input
          id="propose-url"
          name="sourceUrl"
          type="url"
          placeholder="https://…"
          className={inputClass}
        />

        <label className="text-sm font-medium" htmlFor="propose-note">
          Note (optional)
        </label>
        <input
          id="propose-note"
          name="note"
          maxLength={500}
          placeholder="Everyone loved these last time"
          className={inputClass}
        />

        <Feedback state={newState} />

        <button type="submit" disabled={newPending} className={buttonClass}>
          {newPending ? "Adding…" : "Propose dish"}
        </button>
      </form>

      {libraryDishes.length > 0 ? (
        <form action={recycleAction} className="flex flex-col gap-3 text-left">
          <h3 className="font-medium">Propose again</h3>
          <input type="hidden" name="weekStart" value={weekStart} readOnly />

          <label className="text-sm font-medium" htmlFor="recycle-dish">
            Propose again from your library
          </label>
          <select
            id="recycle-dish"
            name="dishId"
            required
            defaultValue=""
            className={inputClass}
          >
            <option value="" disabled>
              Choose a dish…
            </option>
            {libraryDishes.map((dish) => (
              <option key={dish.id} value={dish.id}>
                {dish.title}
              </option>
            ))}
          </select>

          <label className="text-sm font-medium" htmlFor="recycle-note">
            Note (optional)
          </label>
          <input
            id="recycle-note"
            name="note"
            maxLength={500}
            placeholder="Let's have this again"
            className={inputClass}
          />

          <Feedback state={recycleState} />

          <button
            type="submit"
            disabled={recyclePending}
            className={buttonClass}
          >
            {recyclePending ? "Adding…" : "Propose again"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
