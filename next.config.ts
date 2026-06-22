import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for a minimal Docker image
  // (consumed by the Cloud Run deploy stub's Dockerfile).
  output: "standalone",
};

export default nextConfig;
