import { describe, expect, it } from 'vitest'
import { createAiProgressService, type AiProgressRedisLike } from '../src/realtime/ai-progress.js'

class FakeSubscriber {
  listener: ((pattern: string, channel: string, message: string) => void) | null = null

  async psubscribe() {
    return 1
  }
  on(_event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void) {
    this.listener = listener
    return this
  }
  disconnect() {}
}

class FakeRedis implements AiProgressRedisLike {
  readonly subscriber = new FakeSubscriber()

  duplicate() {
    return this.subscriber
  }
  async publish(channel: string, message: string) {
    this.subscriber.listener?.('vmai:annotation:ai-progress:v1:*', channel, message)
    return 1
  }
}

const roomId =
  'match:00000000-0000-4000-8000-000000000010:capture:00000000-0000-4000-8000-000000000110'

describe('AI progress pubsub', () => {
  it('validates and delivers a room-scoped processing update', async () => {
    const service = createAiProgressService(new FakeRedis())
    const messages: unknown[] = []
    const unsubscribe = await service.subscribe(roomId, message => messages.push(message))
    await service.publish({
      schema_version: '2.0.0',
      type: 'rally_processing_update',
      room_id: roomId,
      rally_id: '00000000-0000-4000-8000-000000000210',
      submission_id: '00000000-0000-4000-8000-000000000310',
      processing_status: 'ai_processing',
      ai_job_id: '00000000-0000-4000-8000-000000000410',
      worker_instance_key: 'gpu-01',
      provider_build_id: 'engine/0.1.0',
      progress: 0.62,
      stage: 'hit_association',
      updated_at: '2026-08-09T12:00:00.000Z',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ stage: 'hit_association', progress: 0.62 })
    unsubscribe()
    service.close()
  })
})
