import Fastify, { type FastifyInstance } from 'fastify'
import { parseCanonicalFrameAnchor, parseResolvedMediaAnchor } from '@volleyball-monitoring/contracts'
import { UserRole } from '@volleyball-monitoring/db/client'
import {
  buildSampleIndex,
  type IndexedSegment,
} from '@volleyball-monitoring/media'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  mediaCursorRoutes,
  type MediaCursorRouteDependencies,
} from '../src/media/cursor-routes.js'
import type {
  CursorMediaIdentity,
  CursorPlaybackWindow,
  CursorWindowSegment,
  CursorWindowStore,
} from '../src/media/cursor-resolution.js'

const ids = {
  epoch: '51000000-0000-4000-8000-000000000001',
  match: '51000000-0000-4000-8000-000000000002',
  operator: '51000000-0000-4000-8000-000000000003',
  outsider: '51000000-0000-4000-8000-000000000004',
  program: '51000000-0000-4000-8000-000000000005',
  segment1: '51000000-0000-4000-8000-000000000006',
  segment2: '51000000-0000-4000-8000-000000000007',
  session: '51000000-0000-4000-8000-000000000008',
  foreignSession: '51000000-0000-4000-8000-000000000009',
  window: '51000000-0000-4000-8000-000000000010',
}

const now = new Date('2026-08-07T04:00:00.000Z')
const captureOriginUs = 9_007_199_254_740_993n
const captureFrameOrigin = 9_007_199_254_741_993n
const sourcePtsOrigin = -9_007_199_254_740_993n
const sampleDurationPts = 1_002n
const timeBase = { num: 1n, den: 60_000n }
const epochOrigin = {
  captureFrameOrigin,
  captureTimeOriginUs: captureOriginUs,
  epochId: ids.epoch,
  sourcePtsOrigin,
  timeBase,
}

function sampleFrame(sourcePts: bigint, keyFrame = false) {
  return {
    key_frame: keyFrame ? 1 : 0,
    media_type: 'video' as const,
    pkt_duration: sampleDurationPts.toString(),
    pts: sourcePts.toString(),
  }
}

const firstIndex = buildSampleIndex(
  [
    sampleFrame(sourcePtsOrigin, true),
    sampleFrame(sourcePtsOrigin + sampleDurationPts),
  ],
  epochOrigin,
)
const secondIndex = buildSampleIndex(
  [
    sampleFrame(sourcePtsOrigin + 2n * sampleDurationPts),
    sampleFrame(sourcePtsOrigin + 3n * sampleDurationPts),
  ],
  { ...epochOrigin, captureFrameOrigin: captureFrameOrigin + 2n },
)
const indexedSegments: readonly IndexedSegment[] = [
  { discontinuity: 0, index: firstIndex, segmentId: ids.segment1 },
  { discontinuity: 0, index: secondIndex, segmentId: ids.segment2 },
]

function mapping(
  id: string,
  indexed: IndexedSegment,
  sequenceIndex: number,
): CursorWindowSegment {
  return {
    captureEndUs: indexed.index.availableEndUs,
    captureEpochId: ids.epoch,
    captureStartUs: indexed.index.availableStartUs,
    discontinuity: 0,
    dvrProgramId: ids.program,
    firstFrameIndex: indexed.index.samples[0]!.captureFrameIndex,
    frameCount: BigInt(indexed.index.samples.length),
    id,
    isGap: false,
    ready: true,
    sequenceIndex,
    sequenceNumber: BigInt(sequenceIndex),
  }
}

const firstMapping = mapping(ids.segment1, indexedSegments[0]!, 0)
const secondMapping = mapping(ids.segment2, indexedSegments[1]!, 1)

function fullWindow(): CursorPlaybackWindow {
  return {
    captureEndUs: secondIndex.availableEndUs,
    captureSessionId: ids.session,
    captureStartUs: firstIndex.availableStartUs,
    dvrProgramId: ids.program,
    expiresAt: new Date(now.getTime() + 60_000),
    id: ids.window,
    mappingVersion: 3,
    presentationOriginCaptureUs: firstIndex.availableStartUs,
    programCaptureSessionId: ids.session,
    segments: [firstMapping, secondMapping],
  }
}

const identities: Record<string, CursorMediaIdentity> = {
  operator: { id: ids.operator, role: UserRole.OPERATOR },
  outsider: { id: ids.outsider, role: UserRole.OPERATOR },
}

function cursorBody(playerMediaTimeUs: bigint) {
  return {
    cursor_status: 'ready',
    mapping_version: 3,
    observation_source: 'request_video_frame_callback',
    playback_window_id: ids.window,
    player_media_time_us: playerMediaTimeUs.toString(),
    presented_frames: '9007199254740993',
    schema_version: '1.0.0',
    seek_generation: 2,
  }
}

function stepBody(captureFrameIndex: bigint, direction: 'previous' | 'next') {
  return {
    capture_frame_index: captureFrameIndex.toString(),
    capture_session_id: ids.session,
    direction,
    mapping_version: 3,
    playback_window_id: ids.window,
    schema_version: '1.0.0',
  }
}

function testHeaders(user: keyof typeof identities = 'operator') {
  return { 'x-test-user': user }
}

let app: FastifyInstance
let visibleWindow: CursorPlaybackWindow
let adjacent: CursorWindowSegment | null
let storeFailure: Error | null
let indexFailure: Error | null
let loadedSegmentIds: string[][]

beforeEach(async () => {
  visibleWindow = fullWindow()
  adjacent = null
  storeFailure = null
  indexFailure = null
  loadedSegmentIds = []
  const store: CursorWindowStore = {
    async loadAdjacentSegment() {
      return adjacent
    },
    async loadVisibleWindow(_id, identity) {
      if (storeFailure) throw storeFailure
      return identity.id === ids.outsider ? null : visibleWindow
    },
  }
  const dependencies: MediaCursorRouteDependencies = {
    authenticate: async (request) => {
      const key = request.headers['x-test-user']
      return typeof key === 'string' ? identities[key] ?? null : null
    },
    now: () => now,
    sampleIndexes: {
      async loadOrderedSegments(segmentIds) {
        loadedSegmentIds.push([...segmentIds])
        if (indexFailure) throw indexFailure
        return segmentIds.map((id) =>
          indexedSegments.find((segment) => segment.segmentId === id)!)
      },
    },
    store,
  }
  app = Fastify({ logger: false })
  await app.register(mediaCursorRoutes(dependencies))
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('media cursor HTTP authorization and validation', () => {
  it('rejects unauthenticated and non-member callers without exposing a window', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json().code).toBe('UNAUTHENTICATED')

    const outsider = await app.inject({
      headers: testHeaders('outsider'),
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(outsider.statusCode).toBe(404)
    expect(outsider.json().code).toBe('NOT_FOUND')
    expect(loadedSegmentIds).toHaveLength(0)
  })

  it('strictly rejects malformed and non-ready cursor observations', async () => {
    const malformed = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...cursorBody(0n), unexpected: 'field' },
      url: '/api/v1/media/resolve-cursor',
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().code).toBe('BAD_REQUEST')

    const stale = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...cursorBody(0n), cursor_status: 'stale' },
      url: '/api/v1/media/resolve-cursor',
    })
    expect(stale.statusCode).toBe(422)
    expect(stale.json().code).toBe('CURSOR_NOT_READY')
  })

  it('rejects malformed, stale, expired and out-of-window mappings', async () => {
    const malformedId = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...cursorBody(0n), playback_window_id: 'not-a-uuid' },
      url: '/api/v1/media/resolve-cursor',
    })
    expect(malformedId.statusCode).toBe(404)

    const stale = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...cursorBody(0n), mapping_version: 2 },
      url: '/api/v1/media/resolve-cursor',
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('MAPPING_STALE')

    visibleWindow = {
      ...fullWindow(),
      expiresAt: new Date(now.getTime() - 1),
    }
    const expired = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(expired.statusCode).toBe(410)
    expect(expired.json().code).toBe('WINDOW_EXPIRED')

    visibleWindow = fullWindow()
    const outside = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(visibleWindow.captureEndUs - visibleWindow.captureStartUs),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(outside.statusCode).toBe(422)
    expect(outside.json().code).toBe('CAPTURE_GAP')
  })

  it('fails closed on foreign window state and sanitizes internal failures', async () => {
    visibleWindow = {
      ...fullWindow(),
      programCaptureSessionId: ids.foreignSession,
    }
    const foreign = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(foreign.statusCode).toBe(409)
    expect(foreign.json().code).toBe('MEDIA_NOT_READY')

    visibleWindow = fullWindow()
    indexFailure = new Error(
      's3://secret-bucket/private/index.json credential=top-secret',
    )
    const unavailable = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(unavailable.statusCode).toBe(409)
    expect(unavailable.json().code).toBe('MEDIA_NOT_READY')
    expect(unavailable.body).not.toMatch(/secret|bucket|credential|index\.json/i)

    indexFailure = null
    storeFailure = new Error('postgresql://secret:credential@private-host/db')
    const failedRead = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(0n),
      url: '/api/v1/media/resolve-cursor',
    })
    expect(failedRead.statusCode).toBe(500)
    expect(failedRead.body).not.toMatch(/postgresql|private-host|credential/i)
  })
})

describe('authoritative cursor resolution', () => {
  it('resolves globally across segments with deterministic tie-earlier and decimal bigint wire values', async () => {
    const earlier = firstIndex.samples.at(-1)!
    const later = secondIndex.samples[0]!
    const midpoint = earlier.captureTimeUs
      + (later.captureTimeUs - earlier.captureTimeUs) / 2n
    const response = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: cursorBody(midpoint - captureOriginUs),
      url: '/api/v1/media/resolve-cursor',
    })

    expect(response.statusCode).toBe(200)
    const anchor = parseResolvedMediaAnchor(response.json())
    expect(anchor.dvr_segment_id).toBe(ids.segment1)
    expect(anchor.capture_time_us).toBe(earlier.captureTimeUs.toString())
    expect(anchor.capture_frame_index).toBe(
      earlier.captureFrameIndex.toString(),
    )
    expect(anchor.source_pts).toBe(earlier.sourcePts.toString())
    expect(anchor.source_pts.startsWith('-')).toBe(true)
    expect(BigInt(anchor.capture_time_us)).toBeGreaterThan(2n ** 53n)
    expect(anchor.snap_distance_us).toBe('8350')
    expect(anchor.source_time_base).toEqual({ den: 60_000, num: 1 })
    expect(loadedSegmentIds).toEqual([[ids.segment1, ids.segment2]])
  })
})

describe('canonical frame-step HTTP', () => {
  it('steps exactly forward and backward within one persisted segment', async () => {
    const first = firstIndex.samples[0]!
    const second = firstIndex.samples[1]!
    const forward = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(first.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(forward.statusCode).toBe(200)
    expect(parseCanonicalFrameAnchor(forward.json()).capture_frame_index).toBe(
      second.captureFrameIndex.toString(),
    )

    const backward = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(second.captureFrameIndex, 'previous'),
      url: '/api/v1/media/frame-step',
    })
    expect(backward.statusCode).toBe(200)
    expect(parseCanonicalFrameAnchor(backward.json()).capture_frame_index).toBe(
      first.captureFrameIndex.toString(),
    )
  })

  it('steps exactly across a mapped segment boundary', async () => {
    const current = firstIndex.samples.at(-1)!
    const expected = secondIndex.samples[0]!
    const response = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(current.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(response.statusCode).toBe(200)
    const anchor = parseCanonicalFrameAnchor(response.json())
    expect(anchor.dvr_segment_id).toBe(ids.segment2)
    expect(anchor.capture_frame_index).toBe(expected.captureFrameIndex.toString())
    expect(anchor.player_media_time_us).toBe(
      (expected.captureTimeUs - captureOriginUs).toString(),
    )
    expect(loadedSegmentIds).toEqual([[ids.segment1, ids.segment2]])
  })

  it('distinguishes a playback-window boundary from an actual missing sample', async () => {
    visibleWindow = {
      ...fullWindow(),
      captureEndUs: firstIndex.availableEndUs,
      segments: [firstMapping],
    }
    adjacent = secondMapping
    const boundary = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(firstIndex.samples.at(-1)!.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(boundary.statusCode).toBe(409)
    expect(boundary.json().code).toBe('WINDOW_BOUNDARY')
    expect(loadedSegmentIds).toEqual([[ids.segment1, ids.segment2]])

    visibleWindow = fullWindow()
    adjacent = null
    loadedSegmentIds = []
    const missing = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(secondIndex.samples.at(-1)!.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })
    expect(missing.statusCode).toBe(422)
    expect(missing.json().code).toBe('SAMPLE_NOT_FOUND')
    expect(loadedSegmentIds).toEqual([[ids.segment2]])
  })

  it('does not use an unready out-of-window segment for boundary detection', async () => {
    visibleWindow = {
      ...fullWindow(),
      captureEndUs: firstIndex.availableEndUs,
      segments: [firstMapping],
    }
    adjacent = { ...secondMapping, ready: false }
    const response = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: stepBody(firstIndex.samples.at(-1)!.captureFrameIndex, 'next'),
      url: '/api/v1/media/frame-step',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('SAMPLE_NOT_FOUND')
    expect(loadedSegmentIds).toEqual([[ids.segment1]])
  })

  it('rejects foreign sessions and malformed frame-step bodies', async () => {
    const foreign = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...stepBody(captureFrameOrigin, 'next'), capture_session_id: ids.foreignSession },
      url: '/api/v1/media/frame-step',
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json().code).toBe('NOT_FOUND')

    const malformed = await app.inject({
      headers: testHeaders(),
      method: 'POST',
      payload: { ...stepBody(captureFrameOrigin, 'next'), step_count: 1 },
      url: '/api/v1/media/frame-step',
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().code).toBe('BAD_REQUEST')
  })
})
