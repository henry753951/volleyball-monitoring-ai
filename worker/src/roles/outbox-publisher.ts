import type { PrismaClient } from '@volleyball-monitoring/db'
import { PgBoss } from 'pg-boss'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'

export const OUTBOX_QUEUE = 'domain-events-v1'
const MAX_ATTEMPTS = 10
const CLAIM_LEASE_MS = 30_000

export type OutboxEnvelope = {
  schema_version: '1.0.0'
  outbox_event_id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  dedupe_key: string
  payload: unknown
  created_at: string
}

export interface DurableOutboxPublisher {
  start(): Promise<void>
  stop(): Promise<void>
  send(envelope: OutboxEnvelope): Promise<string | null>
}

export function createPgBossOutboxPublisher(connectionString: string): DurableOutboxPublisher {
  const boss = new PgBoss({ connectionString, max: 2, useListenNotify: true })
  return {
    async start() {
      await boss.start()
      try {
        await boss.createQueue(OUTBOX_QUEUE, {
          retryLimit: 0,
          retentionSeconds: 7 * 24 * 60 * 60,
          deleteAfterSeconds: 7 * 24 * 60 * 60,
        })
      } catch (error) {
        await boss.stop({ graceful: true }).catch(() => undefined)
        throw error
      }
    },
    async stop() {
      await boss.stop({ graceful: true })
    },
    async send(envelope) {
      return boss.send(OUTBOX_QUEUE, envelope, {
        id: envelope.outbox_event_id,
        singletonKey: envelope.dedupe_key,
      })
    },
  }
}

const retryDelayMs = (attempt: number) =>
  Math.min(60 * 60_000, 1_000 * 2 ** Math.min(10, Math.max(0, attempt - 1)))
const sanitizedFailure = (error: unknown) =>
  `OUTBOX_PUBLISH_FAILED:${error instanceof Error ? error.name : 'UnknownError'}`.slice(0, 500)

export function createOutboxPublisherWorker(
  database: PrismaClient,
  publisher: DurableOutboxPublisher,
  options: {
    now?: () => Date
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
  } = {},
): PollingLifecycle {
  const now = options.now ?? (() => new Date())

  async function processNext(signal: AbortSignal): Promise<boolean> {
    const claimTime = now()
    const candidate = await database.outboxEvent.findFirst({
      where: { status: 'PENDING', availableAt: { lte: claimTime } },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })
    if (!candidate) return false

    const attempt = candidate.attempts + 1
    const claimed = await database.outboxEvent.updateMany({
      where: {
        id: candidate.id,
        status: 'PENDING',
        attempts: candidate.attempts,
        availableAt: { lte: claimTime },
      },
      data: {
        attempts: attempt,
        availableAt: new Date(claimTime.getTime() + CLAIM_LEASE_MS),
        lastError: null,
      },
    })
    // Yield when another replica won the CAS; returning true here would create
    // a tight retry loop that can starve cancellation and other workers.
    if (claimed.count !== 1) return false
    if (signal.aborted) {
      await database.outboxEvent.updateMany({
        where: { id: candidate.id, status: 'PENDING', attempts: attempt },
        data: { availableAt: claimTime },
      })
      return true
    }

    const envelope: OutboxEnvelope = {
      schema_version: '1.0.0',
      outbox_event_id: candidate.id,
      aggregate_type: candidate.aggregateType,
      aggregate_id: candidate.aggregateId,
      event_type: candidate.eventType,
      dedupe_key: candidate.dedupeKey,
      payload: candidate.payload,
      created_at: candidate.createdAt.toISOString(),
    }

    try {
      // A null pg-boss result means this exact durable job ID already exists.
      // That is the successful idempotent replay case after a crash between send and DB acknowledgement.
      await publisher.send(envelope)
      const publishedAt = now()
      const updated = await database.outboxEvent.updateMany({
        where: { id: candidate.id, status: 'PENDING', attempts: attempt },
        data: { status: 'PUBLISHED', publishedAt, availableAt: publishedAt, lastError: null },
      })
      if (updated.count !== 1) throw new Error('Outbox publish acknowledgement lost its claim')
    } catch (error) {
      const terminal = attempt >= MAX_ATTEMPTS
      await database.outboxEvent.updateMany({
        where: { id: candidate.id, status: 'PENDING', attempts: attempt },
        data: {
          status: terminal ? 'FAILED' : 'PENDING',
          availableAt: new Date(now().getTime() + retryDelayMs(attempt)),
          lastError: sanitizedFailure(error),
        },
      })
    }
    return true
  }

  const polling = createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'outbox-publisher loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
  })
  return {
    async start() {
      await publisher.start()
      try {
        await polling.start()
      } catch (error) {
        await publisher.stop().catch(() => undefined)
        throw error
      }
    },
    async stop() {
      await polling.stop()
      await publisher.stop()
      if (options.disconnectOnStop !== false) await database.$disconnect()
    },
    runtimeSnapshot: () => polling.runtimeSnapshot!(),
  }
}
