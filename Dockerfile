# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js 15 standalone server, sized for Cloud Run.
# Mirrors the Vercel reference Dockerfile for `output: "standalone"`.

# 1) Install dependencies (cached on lockfile)
# Base image digest-pinned for supply-chain integrity (node 22.x slim, bookworm).
# Update the digest deliberately; `docker buildx imagetools inspect node:22-slim`.
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 2) Build the standalone server
# node 22.x slim, digest-pinned (see stage 1).
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js inlines NEXT_PUBLIC_* into the CLIENT bundle at BUILD time, so the
# public Supabase URL + anon (publishable) key must be present HERE — a runtime
# env/secret binding is too late (lib/supabase/env.ts throws the moment the
# browser client loads). These are non-secret public values (public URL +
# publishable/anon key), so build-arg exposure is fine; the service-role key is
# never built in. The deploy workflow sources both from Secret Manager and
# passes them as --build-arg (see .github/workflows/ci.yml, docs/ci.md).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

# 3) Minimal runtime image
# node 22.x slim, digest-pinned (see stage 1).
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT; Next's standalone server honors it.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone output carries its own trimmed node_modules + server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Uncomment once a public/ dir exists:
# COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
