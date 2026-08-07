import SchemaBuilder from '@pothos/core'
import PrismaPlugin from '@pothos/plugin-prisma'
import { db } from '@volleyball-monitoring/db'
import type PrismaTypes from '@volleyball-monitoring/db/pothos'
import { getDatamodel } from '@volleyball-monitoring/db/pothos'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from './context.js'

export const builder = new SchemaBuilder<{
  Context: GraphQLContext
  DefaultFieldNullability: false
  PrismaTypes: PrismaTypes
  Scalars: {
    BigInt: { Input: bigint; Output: bigint }
    DateTime: { Input: Date; Output: Date }
    JSON: { Input: unknown; Output: unknown }
  }
}>({
  defaultFieldNullability: false,
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
    return value.toString()
  },
  parseValue(value) {
    if (typeof value !== 'string' || !DECIMAL_INT.test(value)) {
      throw new GraphQLError('BigInt must be a decimal integer string', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }
    return BigInt(value)
  },
})

builder.scalarType('DateTime', {
  serialize(value) {
    if (Number.isNaN(value.getTime())) {
      throw new GraphQLError('Invalid DateTime output')
    }
    return value.toISOString()
  },
  parseValue(value) {
    if (typeof value !== 'string') {
      throw new GraphQLError('DateTime must be an ISO-8601 string', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }

    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      throw new GraphQLError('Invalid DateTime', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }
    return parsed
  },
})

builder.scalarType('JSON', {
  serialize: (value) => value,
  parseValue: (value) => value,
})
