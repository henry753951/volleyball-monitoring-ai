FROM oven/bun:1.3.14-alpine AS build
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile=false
RUN bun run db:generate
RUN bun --cwd worker build

FROM oven/bun:1.3.14-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["bun", "--cwd", "worker", "start"]
