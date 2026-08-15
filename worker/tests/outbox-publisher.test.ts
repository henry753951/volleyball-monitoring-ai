import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import {
  createOutboxPublisherWorker,
  type DurableOutboxPublisher,
  type OutboxEnvelope,
} from '../src/roles/outbox-publisher.js'

type EventState = {
  id: string
  aggregateType: string
  aggregateId: string
  eventType: string
  dedupeKey: string
  payload: unknown
  status: 'PENDING' | 'PUBLISHED' | 'FAILED'
  attempts: number
  availableAt: Date
  publishedAt: Date | null
  lastError: string | null
  createdAt: Date
}

const event = (): EventState => ({
  id: '00000000-0000-4000-8000-00000000e001',
  aggregateType: 'Rally',
  aggregateId: '00000000-0000-4000-8000-00000000a001',
  eventType: 'annotation.command_accepted.v2',
  dedupeKey: 'annotation-accepted:41',
  payload: { command_id: '00000000-0000-4000-8000-00000000c001' },
  status: 'PENDING',
  attempts: 0,
  availableAt: new Date(0),
  publishedAt: null,
  lastError: null,
  createdAt: new Date('2026-08-08T00:00:00.000Z'),
})

function fakeDatabase(state: EventState, claimWins = true) {
  let disconnected = false
  const database = {
    outboxEvent: {
      findFirst: async ({ where }: { where: { status: string; availableAt: { lte: Date } } }) =>
        state.status === where.status && state.availableAt <= where.availableAt.lte
          ? { ...state }
          : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        if (!claimWins && where.attempts === 0) return { count: 0 }
        if (
          where.id !== state.id ||
          (where.status !== undefined && where.status !== state.status) ||
          (where.attempts !== undefined && where.attempts !== state.attempts)
        )
          return { count: 0 }
        Object.assign(state, data)
        return { count: 1 }
      },
    },
    $disconnect: async () => {
      disconnected = true
    },
  }
  return { database: database as unknown as PrismaClient, disconnected: () => disconnected }
}

function fakePublisher(send: (envelope: OutboxEnvelope) => Promise<string | null>) {
  const lifecycle = { started: 0, stopped: 0 }
  const publisher: DurableOutboxPublisher = {
    async start() {
      lifecycle.started += 1
    },
    async stop() {
      lifecycle.stopped += 1
    },
    send,
  }
  return { publisher, lifecycle }
}

async function eventually(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
  assertion()
}

describe('outbox publisher worker', () => {
  it('publishes one canonical envelope and marks the durable row published', async () => {
    const state = event()
    const db = fakeDatabase(state)
    const envelopes: OutboxEnvelope[] = []
    const output = fakePublisher(async envelope => {
      envelopes.push(envelope)
      return envelope.outbox_event_id
    })
    let clock = Date.parse('2026-08-08T00:01:00.000Z')
    const worker = createOutboxPublisherWorker(db.database, output.publisher, {
      idleMs: 1,
      now: () => new Date((clock += 1_000)),
    })

    await worker.start()
    await eventually(() => expect(state.status).toBe('PUBLISHED'))
    await worker.stop()

    expect(envelopes).toEqual([
      {
        schema_version: '1.0.0',
        outbox_event_id: state.id,
        aggregate_type: 'Rally',
        aggregate_id: state.aggregateId,
        event_type: state.eventType,
        dedupe_key: state.dedupeKey,
        payload: state.payload,
        created_at: '2026-08-08T00:00:00.000Z',
      },
    ])
    expect(state.attempts).toBe(1)
    expect(state.lastError).toBeNull()
    expect(output.lifecycle).toEqual({ started: 1, stopped: 1 })
    expect(db.disconnected()).toBe(true)
  })

  it('treats an existing pg-boss job ID as an idempotent success', async () => {
    const state = event()
    const db = fakeDatabase(state)
    const output = fakePublisher(async () => null)
    const worker = createOutboxPublisherWorker(db.database, output.publisher, {
      idleMs: 1,
      now: () => new Date('2026-08-08T00:01:00.000Z'),
    })

    await worker.start()
    await eventually(() => expect(state.status).toBe('PUBLISHED'))
    await worker.stop()
    expect(state.attempts).toBe(1)
  })

  it('uses bounded retry/dead-letter state without persisting the transport error text', async () => {
    const state = event()
    const db = fakeDatabase(state)
    const output = fakePublisher(async () => {
      throw new Error('postgres://user:secret@internal/db')
    })
    let clock = Date.parse('2026-08-08T00:01:00.000Z')
    const worker = createOutboxPublisherWorker(db.database, output.publisher, {
      idleMs: 1,
      now: () => new Date((clock += 3_700_000)),
    })

    await worker.start()
    await eventually(() => expect(state.status).toBe('FAILED'))
    await worker.stop()

    expect(state.attempts).toBe(10)
    expect(state.lastError).toBe('OUTBOX_PUBLISH_FAILED:Error')
    expect(state.lastError).not.toContain('secret')
  })

  it('does not publish when another worker wins the claim CAS', async () => {
    const state = event()
    const db = fakeDatabase(state, false)
    let sends = 0
    const output = fakePublisher(async () => {
      sends += 1
      return 'unexpected'
    })
    const worker = createOutboxPublisherWorker(db.database, output.publisher, {
      idleMs: 1,
      now: () => new Date('2026-08-08T00:01:00.000Z'),
    })

    await worker.start()
    await new Promise(resolve => setTimeout(resolve, 10))
    await worker.stop()

    expect(sends).toBe(0)
    expect(state.attempts).toBe(0)
  })
})
