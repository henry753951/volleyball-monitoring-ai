import { describe, expect, it } from 'vitest'
import { UserRole } from '@volleyball-monitoring/db/client'
import {
  getActiveAnnotationSnapshot,
  getAnnotationSnapshot,
} from '../src/services/annotation-snapshot.js'

describe('annotation snapshot authorization and wire safety', () => {
  it('returns an authorized room snapshot with decimal bigint fields', async () => {
    const database = {
      matchMember: { findFirst: async () => ({}) },
      rally: {
        findFirst: async () => ({
          id: '81000000-0000-4000-8000-000000000004',
          annotationRevision: 9007199254740993n,
          annotationStatus: 'OPEN',
          scoreResolutionState: 'PENDING',
          scoringCourtSide: null,
          processingStatus: 'IDLE',
          activeSubmissionId: null,
          sideAssignmentId: '81000000-0000-4000-8000-000000000006',
          keyPoints: [
            {
              id: '81000000-0000-4000-8000-000000000007',
              sequenceIndex: 1,
              markerKind: 'CONTACT',
              isTerminal: false,
              captureTimeUs: 9007199254740993n,
              captureFrameIndex: 9007199254740994n,
              timingPrecision: 'FRAME_EXACT',
              possibleDuplicate: true,
            },
          ],
        }),
      },
      annotationCommandReceipt: {
        aggregate: async () => ({ _max: { serverSequence: 9007199254740995n } }),
      },
    } as never
    const snapshot = await getAnnotationSnapshot(database, {
      roomId:
        'match:81000000-0000-4000-8000-000000000002:capture:81000000-0000-4000-8000-000000000003',
      rallyId: '81000000-0000-4000-8000-000000000004',
      userId: '81000000-0000-4000-8000-000000000008',
      role: UserRole.OPERATOR,
    })
    expect(snapshot).toMatchObject({
      type: 'rally_snapshot',
      revision: '9007199254740993',
      server_sequence: '9007199254740995',
      snapshot: {
        side_assignment_id: '81000000-0000-4000-8000-000000000006',
        key_points: [
          { capture_time_us: '9007199254740993', capture_frame_index: '9007199254740994' },
        ],
      },
    })
  })

  it('rejects outsiders without querying rally state', async () => {
    let queried = false
    const database = {
      matchMember: { findFirst: async () => null },
      rally: {
        findFirst: async () => {
          queried = true
          return null
        },
      },
    } as never
    await expect(
      getAnnotationSnapshot(database, {
        roomId:
          'match:81000000-0000-4000-8000-000000000002:capture:81000000-0000-4000-8000-000000000003',
        rallyId: '81000000-0000-4000-8000-000000000004',
        userId: '81000000-0000-4000-8000-000000000009',
        role: UserRole.VIEWER,
      }),
    ).resolves.toBeNull()
    expect(queried).toBe(false)
  })

  it('scopes the active draft query to the requesting device session', async () => {
    let rallyWhere: unknown = null
    const database = {
      matchMember: { findFirst: async () => ({}) },
      deviceSession: { findFirst: async () => ({ id: 'device-1' }) },
      rally: {
        findFirst: async (input: { where: unknown }) => {
          rallyWhere = input.where
          return null
        },
      },
    } as never
    await expect(
      getActiveAnnotationSnapshot(database, {
        roomId:
          'match:81000000-0000-4000-8000-000000000002:capture:81000000-0000-4000-8000-000000000003',
        deviceSessionId: '81000000-0000-4000-8000-000000000010',
        userId: '81000000-0000-4000-8000-000000000008',
        role: UserRole.OPERATOR,
      }),
    ).resolves.toBeNull()
    expect(rallyWhere).toMatchObject({
      OR: [
        {
          draftOwnerDeviceSessionId: '81000000-0000-4000-8000-000000000010',
        },
        {
          draftOwnerDeviceSessionId: null,
          OR: [
            {
              boundaries: {
                some: {
                  deviceSessionId: '81000000-0000-4000-8000-000000000010',
                  kind: 'START',
                },
              },
            },
            {
              keyPoints: {
                some: {
                  deviceSessionId: '81000000-0000-4000-8000-000000000010',
                  markerKind: 'SERVICE',
                },
              },
            },
          ],
        },
      ],
    })
  })
})
