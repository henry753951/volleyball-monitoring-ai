# `@volleyball-monitoring/db`

Prisma 7/PostgreSQL canonical persistence package.

```bash
bun --cwd packages/db generate
bun --cwd packages/db validate
bun --cwd packages/db migrate
```

`generated/` is intentionally not included in the starter ZIP. Run `generate` before building the server or workers. The Pothos generator emits `generated/pothos.ts`; the generated Prisma client lives under `generated/client/`.

Important invariants that Prisma cannot express alone—one terminal key point per rally, non-overlapping court-side assignment ranges, immutable submissions, and media-range overlap constraints—must be enforced in domain transactions plus SQL migrations/tests.
