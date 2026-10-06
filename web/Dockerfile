# TEAhub Multi-Stage Dockerfile
# Build:   pnpm install (with cache)
# Runner:  Next.js standalone
# Worker:  Minimal entrypoint for background tasks

# =============================================================================
# BASE: Install dependencies (cached layer)
# =============================================================================
FROM node:22-alpine AS base
RUN apk add --no-cache dumb-init
WORKDIR /app

# Install pnpm
RUN corepack enable pnpm

# =============================================================================
# BUILDER: Install deps, generate Prisma/Drizzle, build Next.js
# =============================================================================
FROM base AS builder
WORKDIR /app

# Copy package files first (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
COPY web/drizzle.config.ts web/

# Install dependencies (cached if lockfile unchanged)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Generate Drizzle migrations
RUN pnpm --filter @teahub/web run db:generate

# Build Next.js (outputs standalone)
RUN pnpm --filter @teahub/web run build

# =============================================================================
# RUNNER: Next.js production server (standalone output)
# =============================================================================
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy standalone output (includes node_modules, .next, public)
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./.next/static
COPY --from=builder /app/web/public ./public

# Copy drizzle config and migrations
COPY --from=builder /app/web/drizzle.config.ts ./
COPY --from=builder /app/web/drizzle ./drizzle

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
USER nextjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "node", "server.js"]

# =============================================================================
# WORKER: Minimal entrypoint for background tasks
# =============================================================================
FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production

# Copy only what the worker needs
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/drizzle.config.ts ./
COPY --from=builder /app/web/drizzle ./drizzle
COPY --from=builder /app/web/src/server ./src/server

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1002
USER worker

# Worker entrypoint
CMD ["dumb-init", "node", "src/server/worker/index.js"]