# GraphQL implementation

- Source of truth: Pothos code in this directory.
- Server: GraphQL Yoga mounted on Fastify.
- Prisma integration: `@pothos/plugin-prisma` with generated Pothos types from `packages/db`.
- Generated artifact: `packages/contracts/graphql/schema.graphql` via `bun run graphql:schema`.
- Domain reads and low-frequency mutations use GraphQL.
- Annotation key presses/revision ACKs use `/ws/annotations`, not GraphQL subscriptions.
- Media/HLS, playback cursor resolve, AI callback and FlatBuffers use REST/binary endpoints.

Do not hand-edit the generated SDL.
