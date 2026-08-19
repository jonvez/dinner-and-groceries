"use client";

/**
 * Setting up the store's layout (issue #138, epic #135).
 *
 * This is a sit-down task, not an in-aisle one, so it lives COLLAPSED beneath
 * the list — the shopping list is what a phone screen should be spending its
 * pixels on. Opening it reveals the household's aisles in shopping order, each
 * renameable, movable, and removable.
 *
 * Reordering is BUTTONS, deliberately. Drag-and-drop would need a new
 * dependency, and dragging inside a scrolling list on a phone is hostile even
 * when it works; the issue's "a drag-only reorder is not acceptable" is
 * satisfied by not having a drag at all. Up/Down is keyboard-complete for free.
 *
 * Every edit is OPTIMISTIC and rolls back on failure. `sections` is owned by
 * `GroceryList` so the list above re-groups the instant an aisle moves, and a
 * rollback restores the exact previous array — including the order, which is
 * what the grouping reads.
 *
 * Deleting takes two taps and states where the items go, because this panel
 * sits one thumb-width from a list someone may be standing in a store with.
 * Nothing is lost either way: the composite FK's `on delete set null
 * (section_id)` re-homes the items to Unsorted rather than deleting them.
 */

import { useCallback, useState } from "react";

import {
  createSectionAction,
  deleteSectionAction,
  renameSectionAction,
  reorderSectionsAction,
} from "./actions";
import { type SectionRow } from "./sections-core";

export type SectionEditorProps = {
  sections: SectionRow[];
  /** Lifts an optimistic edit so the grouped list re-renders immediately. */
  onSectionsChange: (sections: SectionRow[]) => void;
};

export function SectionEditor({ sections, onSectionsChange }: SectionEditorProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  /**
   * Apply an edit locally, then persist. On failure the caller's previous array
   * goes back exactly as it was — never a recomputed approximation of it.
   */
  const applyOptimistic = useCallback(
    async (next: SectionRow[], persist: () => Promise<{ ok: boolean; error?: string }>) => {
      const previous = sections;
      setError(null);
      setBusy(true);
      onSectionsChange(next);
      const result = await persist();
      setBusy(false);
      if (!result.ok) {
        onSectionsChange(previous);
        setError(result.error ?? "Could not update the sections.");
      }
    },
    [sections, onSectionsChange],
  );

  const move = useCallback(
    async (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= sections.length) return;
      const next = [...sections];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      // `position` values stay stale until the server snapshot lands; the
      // grouping reads ARRAY order, so the list is already correct.
      await applyOptimistic(next, () =>
        reorderSectionsAction(next.map((section) => section.id)),
      );
    },
    [sections, applyOptimistic],
  );

  const commitRename = useCallback(
    async (section: SectionRow) => {
      const name = renameValue.trim();
      setRenamingId(null);
      if (name === "" || name === section.name) return;
      await applyOptimistic(
        sections.map((row) => (row.id === section.id ? { ...row, name } : row)),
        () => renameSectionAction(section.id, name),
      );
    },
    [renameValue, sections, applyOptimistic],
  );

  const remove = useCallback(
    async (section: SectionRow) => {
      setConfirmingId(null);
      await applyOptimistic(
        sections.filter((row) => row.id !== section.id),
        () => deleteSectionAction(section.id),
      );
    },
    [sections, applyOptimistic],
  );

  // Not optimistic: the id is minted by the database, so the new aisle arrives
  // with the revalidated snapshot rather than being guessed at here.
  const add = useCallback(async () => {
    const name = newName.trim();
    if (name === "") return;
    setError(null);
    setBusy(true);
    const result = await createSectionAction(name);
    setBusy(false);
    if (result.ok) setNewName("");
    else setError(result.error);
  }, [newName]);

  return (
    <div className="border-border rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="text-muted-foreground flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
      >
        Edit aisles
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t px-3 py-3">
          <p className="text-muted-foreground text-xs">
            Put these in the order you walk the store. Items you file into an
            aisle stay there next time.
          </p>

          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}

          <ul className="space-y-1.5">
            {sections.map((section, index) => (
              <li
                key={section.id}
                data-testid="aisle-row"
                data-name={section.name}
                className="border-border flex flex-wrap items-center gap-2 rounded-md border p-2"
              >
                {renamingId === section.id ? (
                  <>
                    <label className="sr-only" htmlFor={`rename-${section.id}`}>
                      New name for {section.name}
                    </label>
                    <input
                      id={`rename-${section.id}`}
                      value={renameValue}
                      maxLength={200}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="border-input bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void commitRename(section)}
                      className="border-input rounded-md border px-2 py-1 text-xs font-medium"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      className="text-muted-foreground px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </>
                ) : confirmingId === section.id ? (
                  <>
                    <span className="text-muted-foreground min-w-0 flex-1 text-xs">
                      Its items move to Unsorted — nothing is lost.
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(section)}
                      className="border-destructive text-destructive rounded-md border px-2 py-1 text-xs font-medium"
                    >
                      Delete {section.name}?
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="text-muted-foreground px-2 py-1 text-xs"
                    >
                      Keep {section.name}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {section.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`Move ${section.name} up`}
                      disabled={index === 0 || busy}
                      onClick={() => void move(index, -1)}
                      className="border-input rounded-md border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      <span aria-hidden="true">↑</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${section.name} down`}
                      disabled={index === sections.length - 1 || busy}
                      onClick={() => void move(index, 1)}
                      className="border-input rounded-md border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename ${section.name}`}
                      onClick={() => {
                        setConfirmingId(null);
                        setRenameValue(section.name);
                        setRenamingId(section.id);
                      }}
                      className="text-muted-foreground px-2 py-1 text-xs"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${section.name}`}
                      onClick={() => {
                        setRenamingId(null);
                        setConfirmingId(section.id);
                      }}
                      className="text-muted-foreground px-2 py-1 text-xs"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label className="sr-only" htmlFor="new-aisle">
                New aisle
              </label>
              <input
                id="new-aisle"
                value={newName}
                maxLength={200}
                placeholder="Bulk bins"
                onChange={(e) => setNewName(e.target.value)}
                className="border-input bg-background rounded-md border px-3 py-1.5 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void add()}
              className="border-input rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              Add aisle
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
