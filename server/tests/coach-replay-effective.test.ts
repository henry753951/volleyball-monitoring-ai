import { describe, expect, it } from 'vitest'
import { projectEffectiveReplayEvents, projectReplayTrack } from '../src/services/coach-replay.js'

describe('coach replay effective contact projection', () => {
  it('keeps GID visible even before a roster player is assigned', () => {
    const track = projectReplayTrack({
      trackId: 7,
      courtSide: 'LEFT',
      firstFrame: 0n,
      lastFrame: 120n,
      meanConfidence: 0.9,
      identityAssignments: [],
      reidObservation: {
        matchConfidence: 0.95,
        identityRevision: 4n,
        reidIdentity: { id: 'gid-1', label: 'G001' },
      },
    } as never)
    expect(track).toMatchObject({
      track_id: 7,
      global_identity: { id: 'gid-1', label: 'G001', source: 'ai', confidence: 0.95, identity_revision: '4' },
      identity: null,
    })
  })

  it('applies time and actor corrections without mutating raw inference', () => {
    const rawActor = {
      trackId: 1, observationFrameIndex: 10n, associationConfidence: 0.8,
      frameX1: 1, frameY1: 2, frameX2: 3, frameY2: 4,
      frameFootX: 2, frameFootY: 4, courtX: 0.2, courtY: 0.4, action: null,
    }
    const analysis = {
      contactTimeCorrections: [{ keyPointId: 'contact-1', frameIndex: 14n }],
      contactActorCorrections: [{ keyPointId: 'contact-1', trackId: 2 }],
      contactEvents: [{
        keyPointId: 'contact-1', sourceKeyPointId: null, anchorOrigin: 'ai_detected',
        detectionConfidence: 0.9, detectionEvidence: null, sequenceIndex: 0,
        markerKind: 'CONTACT', isTerminal: false, anchorFrameIndex: 10n,
        resolvedFrameIndex: 11n, anchorTimeUs: 1000n, associationState: 'RESOLVED_SINGLE',
        ballState: 'OBSERVED', ballFrameIndex: 10n, ballFrameX: 100, ballFrameY: 200,
        qualityFlags: [], actors: [rawActor], candidates: [], representativePositions: [],
      }],
    } as unknown as Parameters<typeof projectEffectiveReplayEvents>[0]

    const [event] = projectEffectiveReplayEvents(analysis)
    expect(event?.wire).toMatchObject({
      resolved_frame_index: '14', association_state: 'resolved_single',
      actors: [{ track_id: 2, observation_frame_index: '14', frame_bbox: null }],
      quality_flags: ['manual_review_effective'],
    })
    expect(rawActor.trackId).toBe(1)
  })
})
