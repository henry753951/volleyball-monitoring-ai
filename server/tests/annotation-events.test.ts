import { parseAnnotationServerMessage } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import {
  createAnnotationSnapshotEventService,
  type AnnotationEventRedisLike,
} from '../src/realtime/annotation-events.js'

class MemorySubscriber {
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

class SharedRedis implements AnnotationEventRedisLike {
  readonly subscribers: MemorySubscriber[] = []
  duplicate() {
    const subscriber = new MemorySubscriber()
    this.subscribers.push(subscriber)
    return subscriber
  }
  async publish(channel: string, message: string) {
    for (const subscriber of this.subscribers)
      subscriber.listener?.('vmai:annotation:rally-snapshots:v1:*', channel, message)
    return this.subscribers.length
  }
}

const roomId =
  'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
const rallyId = '00000000-0000-4000-8000-000000000003'
const snapshot = parseAnnotationServerMessage({
  schema_version: '2.0.0',
  type: 'rally_snapshot',
  room_id: roomId,
  rally_id: rallyId,
  revision: '1',
  server_sequence: '9',
  snapshot: {
    annotation_status: 'open',
    side_assignment_id: '00000000-0000-4000-8000-000000000004',
    score_resolution: 'pending',
    scoring_court_side: null,
    processing_status: 'idle',
    key_points: [],
  },
})
if (snapshot.type !== 'rally_snapshot') throw new TypeError('snapshot fixture mismatch')

describe('annotation Redis snapshot events', () => {
  it('delivers locally once and fans out to another server instance', async () => {
    const redis = new SharedRedis()
    const first = createAnnotationSnapshotEventService(redis)
    const second = createAnnotationSnapshotEventService(redis)
    const firstSeen: string[] = []
    const secondSeen: string[] = []
    await first.subscribe(roomId, message => firstSeen.push(message.server_sequence))
    await second.subscribe(roomId, message => secondSeen.push(message.server_sequence))

    await first.publish(snapshot)

    expect(firstSeen).toEqual(['9'])
    expect(secondSeen).toEqual(['9'])
    first.close()
    second.close()
  })
})
