import SchemaBuilder from '@pothos/core'
import PrismaPlugin from '@pothos/plugin-prisma'
import { db } from '@volleyball-monitoring/db'
import type PrismaTypes from '@volleyball-monitoring/db/pothos'
import { getDatamodel } from '@volleyball-monitoring/db/pothos'
import type { GraphQLContext } from './context.js'

export const builder = new SchemaBuilder<{
  Context: GraphQLContext
  PrismaTypes: PrismaTypes
  Scalars: {
    BigInt: { Input: string; Output: string }
    DateTime: { Input: string; Output: string }
    JSON: { Input: unknown; Output: unknown }
  }
}>({
  plugins: [PrismaPlugin],
  prisma: {
    client: db,
    dmmf: getDatamodel(),
    onUnusedQuery: process.env.NODE_ENV === 'production' ? null : 'warn',
  },
})

const DECIMAL_INT = /^-?\d+$/

builder.scalarType('BigInt', {
  description: 'Signed 64-bit integer serialized as a decimal string.',
  serialize(value) {
    const text = typeof value === 'bigint' ? value.toString() : String(value)
    if (!DECIMAL_INT.test(text)) throw new TypeError('BigInt must be a decimal integer string')
    return text
  },
  parseValue(value) {
    if (typeof value !== 'string' || !DECIMAL_INT.test(value)) {
      throw new TypeError('BigInt input must be a decimal integer string')
    }
    return value
  },
})

builder.scalarType('DateTime', {
  serialize: (value) => value instanceof Date ? value.toISOString() : String(value),
  parseValue(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError('Invalid DateTime')
    return value
  },
})

builder.scalarType('JSON', {
  serialize: (value) => value,
  parseValue: (value) => value,
})
