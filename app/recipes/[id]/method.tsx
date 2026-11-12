"use client";

/**
 * Cook mode for a recipe's method: phases and steps read from `dish_phases` /
 * `dish_steps` (issue #272; inline syntax in `lib/recipes/method-parse.ts`).
 *
 * The outcome it serves is minimal scrolling: each step shows the ingredients it
 * uses, so the cook never scrolls up to the list and back. Tap a step to mark it
 * done; the next step glides to the middle of the screen. Progress persists per
 * dish in localStorage (survives refresh and screen lock), keyed by step id so a
 * recipe edited mid-cook keeps its done steps done (see `cook-progress.ts`). An
 * optional screen wake lock keeps the display on.
 *
 * Stored text renders as plain React children (escaped by construction); there is
 * no HTML parsing and no `dangerouslySetInnerHTML`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { parseSpans } from "@/lib/recipes/method-parse";

import { currentStepId, parseProgress, progressKey } from "./cook-progress";
import type { MethodPhase } from "./method-types";

const PROGRESS_EVENT = "cook-progress";

function subscribeProgress(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PROGRESS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PROGRESS_EVENT, onChange);
  };
}

function useProgress(storageKey: string) {
  const raw = useSyncExternalStore(
    subscribeProgress,
    () => localStorage.getItem(storageKey),
    () => null,
  );
  const done = useMemo(() => parseProgress(raw), [raw]);
  const save = useCallback(
    (next: Set<string> | null) => {
      if (next === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify([...next]));
      window.dispatchEvent(new Event(PROGRESS_EVENT));
    },
    [storageKey],
  );
  return { done, save };
}

const noopSubscribe = () => () => {};

function useWakeLock() {
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => "wakeLock" in navigator,
    () => false,
  );
  const [on, setOn] = useState(false);
  const lock = useRef<WakeLockSentinel | null>(null);

  const acquire = useCallback(async () => {
    try {
      lock.current = await navigator.wakeLock.request("screen");
      lock.current.addEventListener("release", () => {
        if (document.visibilityState === "visible") setOn(false);
      });
      setOn(true);
    } catch {
      setOn(false);
    }
  }, []);

  // The browser drops the lock whenever the tab is hidden; take it back on return.
  useEffect(() => {
    const onVisible = () => {
      if (on && document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [on, acquire]);

  const toggle = useCallback(async () => {
    if (on) {
      await lock.current?.release();
      lock.current = null;
      setOn(false);
    } else {
      await acquire();
    }
  }, [on, acquire]);

  return { supported, on, toggle };
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseSpans(text).map((span, i) => {
        if (span.kind === "ingredient") {
          return (
            <span
              key={i}
              className="mx-0.5 my-0.5 inline-block rounded-md bg-amber-100 px-2 py-0.5 font-semibold text-amber-950 dark:bg-amber-900/60 dark:text-amber-50"
            >
              {span.text}
            </span>
          );
        }
        if (span.kind === "strong") return <strong key={i}>{span.text}</strong>;
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

export function RecipeMethod({ phases, dishId }: { phases: MethodPhase[]; dishId: string }) {
  const steps = useMemo(() => phases.flatMap((p) => p.steps), [phases]);
  const stepIds = useMemo(() => steps.map((s) => s.id), [steps]);
  const total = steps.length;
  const { done, save } = useProgress(progressKey(dishId));
  const current = currentStepId(stepIds, done);
  const currentN = steps.find((s) => s.id === current)?.n ?? null;
  // Only ids that are still steps of this recipe count: a deleted step's id
  // can linger in storage after an edit.
  const anyDone = stepIds.some((id) => done.has(id));
  const wake = useWakeLock();

  const stepRefs = useRef(new Map<string, HTMLLIElement>());
  const scrollTo = (id: string | null) => {
    if (id === null) return;
    stepRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const toggle = (id: string) => {
    const next = new Set(done);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save(next);
    if (!next.has(id)) return;
    const upcoming = currentStepId(stepIds, next);
    // After React paints the new highlight.
    requestAnimationFrame(() => scrollTo(upcoming));
  };

  const reset = () => {
    save(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <section className="space-y-6" aria-label="Method">
      <div className="bg-background/95 sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b py-2 text-sm backdrop-blur">
        <span className="font-medium">
          {currentN === null ? "All done" : `Step ${currentN} of ${total}`}
        </span>
        {!anyDone ? (
          <span className="text-muted-foreground">Tap a step when it’s done</span>
        ) : (
          <button
            type="button"
            onClick={() => scrollTo(current)}
            className="text-primary underline underline-offset-4"
          >
            Jump to current
          </button>
        )}
        <span className="flex-1" />
        {wake.supported ? (
          <button
            type="button"
            onClick={() => void wake.toggle()}
            className="rounded-md border px-2 py-1"
          >
            {wake.on ? "Screen stays on ✓" : "Keep screen on"}
          </button>
        ) : null}
        {anyDone ? (
          <button type="button" onClick={reset} className="text-muted-foreground px-1">
            Reset
          </button>
        ) : null}
      </div>

      {phases.map((phase, pi) => (
        <div key={pi} className="space-y-3">
          {phase.title ? (
            <h3 className="text-lg font-semibold">
              <Inline text={phase.title} />
            </h3>
          ) : null}
          {phase.intro.map((line, i) => (
            <p key={i} className="text-muted-foreground">
              <Inline text={line} />
            </p>
          ))}
          <ol className="space-y-2">
            {phase.steps.map((step) => {
              const isDone = done.has(step.id);
              const isCurrent = step.id === current;
              return (
                <li
                  key={step.id}
                  ref={(el) => {
                    if (el) stepRefs.current.set(step.id, el);
                  }}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <button
                    type="button"
                    aria-pressed={isDone}
                    onClick={() => toggle(step.id)}
                    className={[
                      "flex w-full gap-3 rounded-lg border p-3 text-left text-lg leading-relaxed transition-all select-none",
                      isCurrent ? "border-primary ring-primary/40 bg-primary/5 ring-2" : "",
                      isDone ? "opacity-40" : "",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-base font-semibold",
                        isDone ? "bg-foreground text-background" : "",
                      ].join(" ")}
                    >
                      {isDone ? "✓" : step.n}
                    </span>
                    <span className="space-y-1">
                      <span className="block">
                        <Inline text={step.body} />
                      </span>
                      {step.notes.map((note, i) => (
                        <span key={i} className="block text-base">
                          <Inline text={note} />
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}
