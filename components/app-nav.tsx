"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Global navigation for the authenticated app shell (issue #12z). Rendered by
 * every signed-in screen (Home, Board, Recipes, Groceries; Dashboard later). The
 * login/join screens deliberately do NOT render it. `usePathname` marks the
 * current section — Home matches only the exact root so it isn't "active" on
 * every page.
 *
 * On a phone (below `sm`) the brand takes its own line and the four links sit
 * on the line below, each link narrower (`px-2`) and a 40px-tall tap target, so
 * the nav never makes the page scroll sideways (#196). The row still wraps, as
 * a last resort, if the links can't fit on one line (a very narrow screen, or
 * large text). From `sm` up it's the single row it always was. The side gutter
 * stays `px-6`, matching the pages' `<main>`.
 */

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/board", label: "Board" },
  { href: "/recipes", label: "Recipes" },
  { href: "/grocery", label: "Groceries" },
] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="border-border border-b">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-1 px-6 py-3">
        <span className="w-full text-sm font-semibold tracking-tight sm:mr-3 sm:w-auto">
          Dinner &amp; Groceries
        </span>
        {LINKS.map((link) => {
          const active = isActive(pathname, link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "bg-muted rounded-md px-2 py-2.5 text-sm font-medium sm:px-3 sm:py-1.5"
                  : "text-muted-foreground rounded-md px-2 py-2.5 text-sm sm:px-3 sm:py-1.5"
              }
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
