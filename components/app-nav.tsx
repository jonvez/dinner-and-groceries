"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Global navigation for the authenticated app shell (issue #12z). Rendered by
 * every signed-in screen (Home, Board, Recipes; Grocery/Dashboard later). The
 * login/join screens deliberately do NOT render it. `usePathname` marks the
 * current section — Home matches only the exact root so it isn't "active" on
 * every page.
 */

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/board", label: "Board" },
  { href: "/recipes", label: "Recipes" },
] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="border-border border-b">
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-6 py-3">
        <span className="mr-3 text-sm font-semibold tracking-tight">
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
                  ? "bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
                  : "text-muted-foreground rounded-md px-3 py-1.5 text-sm"
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
