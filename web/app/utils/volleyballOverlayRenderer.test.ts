import { ANALYSIS_BALL_FLAG, ANALYSIS_PLAYER_FLAG, type AnalysisFrameChunk } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import type { ReplayContactEvent } from '~/lib/coachDomain'
import { hitTestOverlayTrack, overlayCanvasPointToVideo, overlayTrackIdentityLabel, replayEventFrame, resolveEffectiveContactActor, resolveEffectiveHitPosition, resolveEventActorFromResult, resolveVideoContentRect, trackColor } from './volleyballOverlayRenderer'

const chunk: AnalysisFrameChunk = {
  schemaVersion: 10_000,
  analysisId: 'analysis',
  analysisDataVersion: '1',
  chunkIndex: 0,
  startFrameIndex: 10n,
  frameCount: 1,
  frameOffsets: [0, 1],
  trackIds: [7],
  frameBboxes: [{ x1: 16_384, y1: 16_384, x2: 32_768, y2: 49_151 }],
  frameFootPositions: [{ x: 24_576, y: 49_151 }],
  courtPositions: [{ x: .25, y: .75 }],
  playerFlags: [ANALYSIS_PLAYER_FLAG.frameBBox | ANALYSIS_PLAYER_FLAG.frameFootPosition | ANALYSIS_PLAYER_FLAG.courtPosition],
  playerConfidences: [240],
  actionLabelIds: [0],
  actionConfidences: [230],
  ballFramePositions: [{ x: 0, y: 0 }],
  ballFlags: [0],
  ballConfidences: [0],
  courtKeypointFrameOffsets: [0, 1],
  courtKeypointIds: [4],
  courtKeypointPositions: [{ x: 1_000, y: 2_000 }],
  courtKeypointConfidences: [240],
}

const event: ReplayContactEvent = {
  key_point_id: '85000000-0000-4000-8000-000000000003', sequence_index: 0, marker_kind: 'contact', is_terminal: false,
  anchor_frame_index: '12', resolved_frame_index: '12', anchor_time_us: '0', association_state: 'resolved',
  ball: { state: 'missing', frame_index: null, frame_pos: null }, quality_flags: [],
  actors: [
    { track_id: 1, observation_frame_index: '12', association_confidence: .8, frame_bbox: { x1: .1, y1: .1, x2: .3, y2: .9 }, frame_foot_pos: null, court_pos: null, action: null },
    { track_id: 2, observation_frame_index: '12', association_confidence: .7, frame_bbox: { x1: .65, y1: .1, x2: .85, y2: .9 }, frame_foot_pos: null, court_pos: null, action: null },
  ],
  candidates: [], representative_court_positions: [],
}

describe('volleyball overlay geometry', () => {
  it('maps the video into the actual letterboxed content rectangle', () => {
    expect(resolveVideoContentRect({ x: 0, y: 0, width: 1_000, height: 1_000 }, 1_920, 1_080)).toEqual({
      x: 0,
      y: 218.75,
      width: 1_000,
      height: 562.5,
    })
  })

  it('hit-tests a quantized player box without creating DOM hit targets', () => {
    const hit = hitTestOverlayTrack({ chunk, frame: 10, videoWidth: 1_000, videoHeight: 1_000, viewport: { x: 0, y: 0, width: 1_000, height: 1_000 } }, { x: 300, y: 500 })
    expect(hit?.trackId).toBe(7)
    expect(hitTestOverlayTrack({ chunk, frame: 10, videoWidth: 1_000, videoHeight: 1_000, viewport: { x: 0, y: 0, width: 1_000, height: 1_000 } }, { x: 900, y: 900 })).toBeNull()
  })

  it('rejects annotation clicks in the letterbox and maps valid clicks to video pixels', () => {
    const viewport = { x: 0, y: 0, width: 1_000, height: 1_000 }
    expect(overlayCanvasPointToVideo({ x: 500, y: 100 }, viewport, 1_920, 1_080)).toBeNull()
    expect(overlayCanvasPointToVideo({ x: 500, y: 500 }, viewport, 1_920, 1_080)).toEqual({ x: 960, y: 540 })
  })

  it('keeps track colors deterministic and distinguishes adjacent IDs', () => {
    expect(trackColor(7)).toBe(trackColor(7))
    expect(trackColor(7)).not.toBe(trackColor(8))
    expect(new Set(Array.from({ length: 12 }, (_, index) => trackColor(index + 1))).size).toBe(12)
  })

  it('renders the canonical TID and GID before the assigned player name', () => {
    expect(overlayTrackIdentityLabel(7, 'L1', '#11 TEST')).toBe('T007  L1  #11 TEST')
    expect(overlayTrackIdentityLabel(7, null, null)).toBe('T007  G---')
  })

  it('uses the last tracked ball when the contact frame is explicitly missing', () => {
    const ballChunk: AnalysisFrameChunk = {
      ...chunk,
      startFrameIndex: 10n,
      frameCount: 3,
      frameOffsets: [0, 0, 0, 0],
      trackIds: [], frameBboxes: [], frameFootPositions: [], courtPositions: [], playerFlags: [], playerConfidences: [], actionLabelIds: [], actionConfidences: [],
      ballFramePositions: [{ x: 32_768, y: 16_384 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      ballFlags: [ANALYSIS_BALL_FLAG.framePosition, 0, 0], ballConfidences: [240, 0, 0],
      courtKeypointFrameOffsets: [0, 0, 0, 0], courtKeypointIds: [], courtKeypointPositions: [], courtKeypointConfidences: [],
    }
    const position = resolveEffectiveHitPosition({ ballCorrections: { 12: { state: 'missing' } }, chunk: ballChunk, videoWidth: 1_000, videoHeight: 500 }, event)
    expect(position?.x).toBeCloseTo(500, 0)
    expect(position?.y).toBeCloseTo(125, 0)
  })

  it('recomputes automatic ownership from a corrected hit position but preserves manual none', () => {
    expect(resolveEventActorFromResult(event, { x: 750, y: 250 }, 1_000, 500)).toBe(2)
    expect(resolveEffectiveContactActor({ ballCorrections: {}, chunk: null, contactActorCorrections: { [event.key_point_id]: null }, playerBBoxCorrections: {}, videoWidth: 1_000, videoHeight: 500 }, event)).toBeNull()
  })

  it('uses the sparse contact-time correction as the effective overlay frame', () => {
    expect(replayEventFrame(event)).toBe(12)
    expect(replayEventFrame(event, { [event.key_point_id]: 14 })).toBe(14)
  })
})
