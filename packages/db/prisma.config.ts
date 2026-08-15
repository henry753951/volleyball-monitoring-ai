import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // A fallback keeps `prisma generate` usable in contract-only CI.
    url:
      process.env.DATABASE_URL ??
      'postgresql://volleyball:volleyball@localhost:5432/volleyball?schema=public',
  },
})
