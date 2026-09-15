"use client";

import { useEffect } from "react";

import { recordSessionStartAction } from "@/app/session-actions";

/**
 * Emits `session_start` ONCE per browser session (issue #210, ADR 0014).
 *
 * Rendered by the authenticated app shell (`AppNav`, which every signed-in
 * screen renders and the login/join screens deliberately do not), so it never
 * fires for a signed-out visitor. The guard is `sessionStorage`: it survives
 * navigation between Board / Recipes / Groceries within the tab's session — so
 * this is a usage signal, NOT a page-view counter (`screen_view` is
 * deliberately not emitted) — and resets in a new tab/session.
 *
 * The flag is set BEFORE the call so React's development double-effect, or two
 * shells mounting at once, cannot emit twice; it is cleared again if the
 * emission did not land, so a later navigation retries (the honest case being a
 * brand-new user who had no household when the shell first mounted).
 *
 * Renders nothing and never throws: a rejected action is swallowed, because
 * analytics must never reach the user.
 */

/** Per-tab guard. `sessionStorage` is cleared when the browser session ends. */
const SESSION_START_KEY = "dag.session_start";

/**
 * Claim this browser session's single emission. Returns false if it is already
 * claimed — or if `sessionStorage` is unusable (Safari private mode and friends
 * can throw on access), in which case we skip emitting rather than emit on
 * every navigation: under-counting a rare edge case beats flooding a Free-tier
 * database with one row per page view.
 */
function claimSession(): boolean {
  try {
    if (window.sessionStorage.getItem(SESSION_START_KEY) === "1") return false;
    window.sessionStorage.setItem(SESSION_START_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Release the claim so a later mount can try again. */
function releaseSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_START_KEY);
  } catch {
    // Nothing to release if storage is unusable.
  }
}

export function SessionBeacon() {
  useEffect(() => {
    if (!claimSession()) return;

    void recordSessionStartAction()
      .then((result) => {
        if (!result?.ok) releaseSession();
      })
      .catch(() => releaseSession());
  }, []);

  return null;
}
