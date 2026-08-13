"use client";

/**
 * The add-a-recipe screen's two-stage form (issue #12c): fetch+extract a
 * preview from a pasted URL (optional), then edit and Save to the library.
 * Nothing is persisted until Save — an abandoned fetch leaves no orphan dish.
 *
 * Ingredient editing is intentionally a single "one per line" textarea, not
 * per-row inputs: raw text is the source of truth (issue #11) and each line is
 * re-parsed via `parseIngredient` server-side on Save.
 *
 * Extraction failure (or skipping the fetch entirely) renders the SAME
 * editable form, empty — manual add-by-hand always works, never a dead end.
 */

import { useActionState, useEffect, useState } from "react";

import {
  fetchRecipePreviewAction,
  saveIngestedDishAction,
  type PreviewState,
  type SaveState,
} from "./actions";

type EditableFields = {
  title: string;
  imageUrl: string;
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  ingredientsText: string;
};

const EMPTY_FIELDS: EditableFields = {
  title: "",
  imageUrl: "",
  prepMinutes: "",
  cookMinutes: "",
  totalMinutes: "",
  ingredientsText: "",
};

function minutesToField(value: number | null): string {
  return value === null ? "" : String(value);
}

const inputClass =
  "border-input bg-background rounded-md border px-3 py-2 text-sm";
const buttonClass =
  "bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60";

export function RecipeIngestForm() {
  const [previewState, fetchAction, fetchPending] = useActionState<PreviewState, FormData>(
    fetchRecipePreviewAction,
    null,
  );
  const [saveState, saveAction, savePending] = useActionState<SaveState, FormData>(
    saveIngestedDishAction,
    null,
  );

  const [fields, setFields] = useState<EditableFields>(EMPTY_FIELDS);
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    if (previewState === null) return;
    // Sync from the server action result (external system) into local
    // editable state — the blessed setState-in-effect case per the rule docs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFields({
      title: previewState.preview.title,
      imageUrl: previewState.preview.imageUrl ?? "",
      prepMinutes: minutesToField(previewState.preview.prepMinutes),
      cookMinutes: minutesToField(previewState.preview.cookMinutes),
      totalMinutes: minutesToField(previewState.preview.totalMinutes),
      ingredientsText: previewState.preview.ingredientLines.join("\n"),
    });
    setSourceUrl(previewState.ok ? previewState.sourceUrl : "");
  }, [previewState]);

  const notice = previewState && !previewState.ok ? previewState.notice : null;

  return (
    <div className="space-y-8">
      <form action={fetchAction} className="flex flex-col gap-3 text-left">
        <h2 className="font-medium">Paste a recipe URL</h2>

        <label className="text-sm font-medium" htmlFor="ingest-url">
          Recipe URL
        </label>
        <input
          id="ingest-url"
          name="url"
          type="url"
          placeholder="https://…"
          className={inputClass}
        />

        <button type="submit" disabled={fetchPending} className={buttonClass}>
          {fetchPending ? "Fetching…" : "Fetch recipe"}
        </button>

        {notice ? (
          <p role="status" className="text-sm text-amber-700">
            {notice}
          </p>
        ) : null}
      </form>

      <form action={saveAction} className="flex flex-col gap-3 text-left">
        <h2 className="font-medium">Recipe details</h2>
        <p className="text-muted-foreground text-sm">
          No link? Just type a title and paste your ingredients below.
        </p>
        <input type="hidden" name="sourceUrl" value={sourceUrl} readOnly />

        <label className="text-sm font-medium" htmlFor="ingest-title">
          Title
        </label>
        <input
          id="ingest-title"
          name="title"
          required
          maxLength={200}
          placeholder="Carnitas tacos"
          value={fields.title}
          onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
          className={inputClass}
        />

        <label className="text-sm font-medium" htmlFor="ingest-image">
          Image URL (optional)
        </label>
        <input
          id="ingest-image"
          name="imageUrl"
          type="url"
          value={fields.imageUrl}
          onChange={(e) => setFields((f) => ({ ...f, imageUrl: e.target.value }))}
          className={inputClass}
        />

        <div className="flex gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-prep">
              Prep (min)
            </label>
            <input
              id="ingest-prep"
              name="prepMinutes"
              type="number"
              min={0}
              value={fields.prepMinutes}
              onChange={(e) => setFields((f) => ({ ...f, prepMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-cook">
              Cook (min)
            </label>
            <input
              id="ingest-cook"
              name="cookMinutes"
              type="number"
              min={0}
              value={fields.cookMinutes}
              onChange={(e) => setFields((f) => ({ ...f, cookMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-total">
              Total (min)
            </label>
            <input
              id="ingest-total"
              name="totalMinutes"
              type="number"
              min={0}
              value={fields.totalMinutes}
              onChange={(e) => setFields((f) => ({ ...f, totalMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
        </div>

        <label className="text-sm font-medium" htmlFor="ingest-ingredients">
          Ingredients — paste your list here, one per line
        </label>
        <textarea
          id="ingest-ingredients"
          name="ingredients"
          rows={8}
          placeholder={"Paste or type your ingredients — one per line:\n2 lb pork shoulder\n1 tbsp ground cumin"}
          value={fields.ingredientsText}
          onChange={(e) => setFields((f) => ({ ...f, ingredientsText: e.target.value }))}
          className={inputClass}
        />

        {/* Success navigates away (PRG → /recipes/{id}); only the failure
            state renders inline. */}
        {saveState && "error" in saveState ? (
          <p role="alert" className="text-destructive text-sm">
            {saveState.error}
          </p>
        ) : null}

        <button type="submit" disabled={savePending} className={buttonClass}>
          {savePending ? "Saving…" : "Save to library"}
        </button>
      </form>
    </div>
  );
}
