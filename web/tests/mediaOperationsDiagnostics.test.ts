import { describe, expect, it } from 'vitest'
import {
  mediaAverageProcessingRate,
  mediaHeartbeat,
  mediaPlayableProgress,
  mediaPreparationProgress,
  mediaWorkStage,
} from '../app/lib/mediaOperationsDiagnostics'
import type { StreamSnapshot } from '../app/lib/operationsMonitor'

function stream(overrides: Partial<StreamSnapshot> = {}): StreamSnapshot {
  return {
    captureSessionId: 'capture-1',
    matchId: 'match-1',
    matchTitle: 'IRI vs PAK',
    sourceKind: 'youtube_vod',
    sourceLabel: 'Gold match',
    sourceDurationUs: '100000000',
    status: 'STARTING',
    health: 'HEALTHY',
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
    completionExpectedSegments: null,
    completionRequestedAt: null,
    epochCount: 0,
    sourceWork: {
      id: 'work-1',
      status: 'RUNNING',
      attempts: 1,
      availableAt: '2026-08-16T00:00:00.000Z',
      leaseExpiresAt: '2026-08-16T00:01:30.000Z',
      lastHeartbeatAt: '2026-08-16T00:01:00.000Z',
      lastErrorCode: null,
      resumeSegmentIndex: 20,
      resumeCaptureTimeUs: '40000000',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    },
    program: {
      id: 'program-1',
      status: 'LIVE',
      playlistRevision: '10',
      liveEdgeUs: '20000000',
      durationUs: '20000000',
      fps: { numerator: 60, denominator: 1 },
      timeBase: { numerator: 1, denominator: 60000 },
      segmentCount: 10,
      readySegmentCount: 10,
      gapSegmentCount: 0,
      frameCount: '1200',
      indexedDurationUs: '20000000',
    },
    ...overrides,
  }
}

describe('media operations diagnostics', () => {
  it('does not call a complete ready subset 100 percent while the source still runs', () => {
    expect(mediaPlayableProgress(stream())).toBe(20)
    expect(mediaPreparationProgress(stream())).toBe(40)
    expect(mediaWorkStage(stream()).key).toBe('segmenting')
  })

  it('only reports 100 percent after both capture and source work complete', () => {
    const completed = stream({
      status: 'FINISHED',
      sourceWork: {
        ...stream().sourceWork!,
        status: 'COMPLETED',
        resumeCaptureTimeUs: '100000000',
      },
      program: { ...stream().program!, indexedDurationUs: '100000000' },
    })
    expect(mediaPlayableProgress(completed)).toBe(100)
    expect(mediaWorkStage(completed).key).toBe('completed')
  })

  it('labels the elapsed calculation as an average and uses the furthest durable progress', () => {
    expect(mediaAverageProcessingRate(stream())).toEqual({ basis: 'prepared', value: 2 / 3 })
  })

  it('marks an active work item stalled when its heartbeat is older than 45 seconds', () => {
    expect(mediaHeartbeat(stream(), '2026-08-16T00:02:00.000Z')).toMatchObject({
      ageSeconds: 60,
      stalled: true,
    })
  })

  it('describes a stopped VOD source that is still draining as indexing, not complete', () => {
    const draining = stream({
      status: 'STOPPING',
      sourceWork: { ...stream().sourceWork!, status: 'DRAINING' },
    })
    expect(mediaWorkStage(draining)).toMatchObject({
      key: 'indexing',
      label: '建立可播放索引',
    })
    expect(mediaPlayableProgress(draining)).toBe(20)
  })
})
