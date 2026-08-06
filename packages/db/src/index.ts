import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/client/client.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required to create PrismaClient')
}

const globalForPrisma = globalThis as unknown as { volleyballPrisma?: PrismaClient }

export const db = globalForPrisma.volleyballPrisma ?? new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.volleyballPrisma = db

export type { PrismaClient }
export * from '../generated/client/enums.js'
