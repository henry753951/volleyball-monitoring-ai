import { builder } from './builder.js'

builder.objectType('Health', {
  fields: (t) => ({
    status: t.exposeString('status'),
    service: t.exposeString('service'),
  }),
})

builder.queryType({
  fields: (t) => ({
    health: t.field({
      type: 'Health',
      resolve: () => ({ status: 'ok', service: 'volleyball-monitoring-server' }),
    }),
  }),
})

// Phase 1+: add Prisma-backed objects and annotation mutations here.
// Phase 3+: add subscriptions backed by Redis/distributed pub-sub.

export const schema = builder.toSchema({ sortSchema: true })
