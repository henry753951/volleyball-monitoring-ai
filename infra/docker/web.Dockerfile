FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
ENV NUXT_TYPECHECK=false
COPY package.json bun.lock bunfig.toml ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/media/package.json packages/media/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
RUN bun --cwd web build

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/web/.output ./web/.output
EXPOSE 3000
CMD ["bun", "web/.output/server/index.mjs"]
