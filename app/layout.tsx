import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Dinner & Groceries",
  description:
    "Plan the family menu together, then let the grocery list flow from it.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    title: "Dinner",
    // "default" keeps the status bar on its own layer. "black-translucent"
    // would draw the app underneath the clock, and there is no
    // env(safe-area-inset-*) handling in the layout to compensate.
    statusBarStyle: "default",
  },
  other: {
    // Next's `appleWebApp` emits only the modern `mobile-web-app-capable`.
    // iOS below 16.4 honors just this legacy tag, and it is the switch that
    // drops the URL bar on launch — one line of insurance for older phones.
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#C2410C",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
