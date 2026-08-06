FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun --cwd web build

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/web/.output ./web/.output
EXPOSE 3000
CMD ["bun", "web/.output/server/index.mjs"]
