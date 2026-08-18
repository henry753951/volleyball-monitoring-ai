import { describe, expect, it } from 'vitest'
import type { CaptureSession, Match } from '~/lib/coreDomain'
import { coachMatchStatus } from './coachMatchStatus'

function capture(overrides: Partial<CaptureSession>): CaptureSession {
  return {
    id: 'capture-1',
    ingestPath: 'youtube-live-capture-1',
    matchId: 'match-1',
    sourceKind: 'youtube_live',
    sourceLabel: null,
    sourceDurationUs: null,
    status: 'FINISHED',
    health: 'OFFLINE',
    startedAt: '2026-08-14T01:00:00.000Z',
    endedAt: '2026-08-14T02:00:00.000Z',
    timeline: null,
    ...overrides,
  }
}

function match(
  status: string,
  captureSessions: CaptureSession[] = [],
): Pick<Match, 'status' | 'captureSessions'> {
  return { status, captureSessions }
}

describe('coach match status', () => {
  it('only calls a healthy active capture live', () => {
    expect(
      coachMatchStatus(match('LIVE', [capture({ status: 'LIVE', health: 'HEALTHY' })])),
    ).toEqual({ kind: 'live', label: '直播中' })
    expect(
      coachMatchStatus(match('LIVE', [capture({ status: 'LIVE', health: 'OFFLINE' })])),
    ).toEqual({ kind: 'failed', label: '直播異常' })
  })

  it('distinguishes completed live and video sources', () => {
    expect(coachMatchStatus(match('LIVE', [capture({ sourceKind: 'youtube_live' })]))).toEqual({
      kind: 'finished',
      label: '直播已結束',
    })
    expect(coachMatchStatus(match('LIVE', [capture({ sourceKind: 'youtube_vod' })]))).toEqual({
      kind: 'ready',
      label: '影片已就緒',
    })
  })

  it('uses explicit lifecycle and recovery states', () => {
    expect(coachMatchStatus(match('PLANNED'))).toEqual({ kind: 'planned', label: '尚未開始' })
    expect(coachMatchStatus(match('FINISHED'))).toEqual({ kind: 'finished', label: '已結束' })
    expect(coachMatchStatus(match('LIVE', [capture({ status: 'FAILED' })]))).toEqual({
      kind: 'failed',
      label: '影音失敗',
    })
    expect(coachMatchStatus(match('LIVE'))).toEqual({ kind: 'processing', label: '等待影音' })
  })
})
