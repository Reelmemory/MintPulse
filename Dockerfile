# MintPulse — Bun-based multi-stage production image
FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server.ts ./
COPY migrations ./migrations

RUN bun run build

FROM oven/bun:1-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -S mintpulse && adduser -S mintpulse -G mintpulse

COPY --from=builder --chown=mintpulse:mintpulse /app/package.json ./package.json
COPY --from=builder --chown=mintpulse:mintpulse /app/bun.lock ./bun.lock
COPY --from=builder --chown=mintpulse:mintpulse /app/node_modules ./node_modules
COPY --from=builder --chown=mintpulse:mintpulse /app/dist ./dist
COPY --from=builder --chown=mintpulse:mintpulse /app/src ./src
COPY --from=builder --chown=mintpulse:mintpulse /app/server.ts ./server.ts
COPY --from=builder --chown=mintpulse:mintpulse /app/migrations ./migrations

USER mintpulse

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["bun", "run", "server.ts"]
