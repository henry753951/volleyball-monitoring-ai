FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile=false
RUN bun run db:generate
RUN bun --cwd server build

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["bun", "--cwd", "server", "start"]
