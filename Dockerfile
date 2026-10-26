FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:slim AS runner
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq git && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["bun", "run", "start"]
