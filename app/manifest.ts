import type { MetadataRoute } from "next";

/**
 * Web app manifest, served at /manifest.webmanifest.
 *
 * Scoped to iOS "Add to Home Screen" (#82): the household runs iPhones, so
 * there is deliberately no service worker and no maskable icon here. A service
 * worker is required only by Chrome's install criteria; iOS needs none, and a
 * worker would sit in front of every authenticated request in an app that is
 * entirely dynamic behind Google OAuth + RLS. The offline shell stays in M2.
 *
 * NOTE: this file convention is only collected at the app root.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dinner & Groceries",
    // iOS truncates the home-screen label at ~12 characters.
    short_name: "Dinner",
    description:
      "Plan the family menu together, then let the grocery list flow from it.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // White to match the app's own background, so launching does not strobe
    // terracotta before the UI paints.
    background_color: "#ffffff",
    theme_color: "#C2410C",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
