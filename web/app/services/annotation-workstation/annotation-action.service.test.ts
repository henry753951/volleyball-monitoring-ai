import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import { ref, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createAnnotationActionService } from './annotation-action.service'
import { createWorkstationActionManager } from './workstation-action.service'

function draft(): AnnotationRallySnapshot {
  return {
    schema_version: '4.0.0',
    type: 'rally_snapshot',
    room_id: 'room',
    rally_id: 'rally',
    revision: '1',
    server_sequence: '1',
    snapshot: {
      annotation_status: 'ready',
      side_assignment_id: 'side',
      score_resolution: 'pending',
      scoring_court_side: null,
      processing_status: 'idle',
      boundaries: [
        {
          kind: 'start',
          capture_time_us: '1000',
          capture_frame_index: '10',
          timing_precision: 'frame_exact',
        },
        {
          kind: 'end',
          capture_time_us: '5000',
          capture_frame_index: '50',
          timing_precision: 'frame_exact',
        },
      ],
      key_points: [
        {
          key_point_id: 'first',
          sequence_index: 0,
          marker_kind: 'contact',
          is_terminal: false,
          capture_time_us: '2000',
          capture_frame_index: '20',
          timing_precision: 'frame_exact',
          possible_duplicate: false,
          ball_event: { kind: 'SERVE', result: 'SUCCESS' },
        },
        {
          key_point_id: 'second',
          sequence_index: 1,
          marker_kind: 'contact',
          is_terminal: false,
          capture_time_us: '3000',
          capture_frame_index: '30',
          timing_precision: 'frame_exact',
          possible_duplicate: false,
          ball_event: { kind: 'RECEIVE', result: null },
        },
      ],
    },
  }
}

function setup() {
  const manager = createWorkstationActionManager()
  const snapshot = shallowRef<AnnotationRallySnapshot | null>(draft())
  const selectedKeyPointId = ref<string | null>('second')
  const dispatch = vi.fn()
  const setBallEvent = vi.fn().mockResolvedValue(undefined)
  const setBallEventActor = vi.fn().mockResolvedValue(undefined)
  const draftOwnedByClient = ref(true)
  const visualPlayhead = ref('3500')
  const state = ref<'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'>('READY')
  const service = createAnnotationActionService({
    manager,
    room: {
      draftOwnedByClient,
      lastKeyPoint: ref({ key_point_id: 'second' }),
      dispatch,
      setBallEvent,
      setBallEventActor,
    },
    commandReady: ref(true),
    state,
    correctionActive: ref(false),
    canMark: ref(true),
    visualPlayhead,
    authoritativeFrameIndex: ref('35'),
    selectedKeyPointId,
    displayAnnotation: snapshot,
    observedCursor: ref(null),
    clipPreRollUs: ref(0n),
    clipPostRollUs: ref(0n),
    protectedSegments: ref([]),
    incompleteResultsNeedConfirmation: () => false,
    requestIncompleteResultsConfirmation: vi.fn(),
    correctionSubmitRequired: ref(false),
    requestCorrectionSubmit: vi.fn(),
    eventEditReady: ref(true),
    submitReady: ref(true),
  })
  return {
    manager,
    service,
    snapshot,
    selectedKeyPointId,
    dispatch,
    setBallEvent,
    setBallEventActor,
    draftOwnedByClient,
    state,
    visualPlayhead,
  }
}

describe('createAnnotationActionService', () => {
  it('keeps C ordinal validation and enables V/B only for selected typed events', () => {
    const { manager, snapshot, selectedKeyPointId } = setup()
    expect(manager.state('mark.event-success').value.enabled).toBe(true)
    expect(manager.state('mark.spike').value).toMatchObject({
      enabled: false,
      reason: '殺球只能標在第三球以後',
    })
    snapshot.value?.snapshot.key_points.push({
      key_point_id: 'third',
      sequence_index: 2,
      marker_kind: 'contact',
      is_terminal: false,
      capture_time_us: '4000',
      capture_frame_index: '40',
      timing_precision: 'frame_exact',
      possible_duplicate: false,
      ball_event: { kind: 'CONTACT', result: null },
    })
    selectedKeyPointId.value = 'third'
    expect(manager.state('mark.event-success').value).toMatchObject({
      enabled: false,
      reason: '請先將球點改為發球、接球或殺球',
    })
    selectedKeyPointId.value = 'first'
    expect(manager.state('mark.event-success').value.enabled).toBe(true)
  })

  it('dispatches through the action manager with the selected point and observation', async () => {
    const { manager, dispatch } = setup()
    expect((await manager.execute('mark.event-success')).status).toBe('executed')
    expect(dispatch).toHaveBeenCalledWith(
      'event_success',
      null,
      { capture_time_us: '3500', capture_frame_index: '35' },
      'second',
    )
  })

  it('keeps peer drafts read-only without blocking this client from starting its own draft', () => {
    const { manager, draftOwnedByClient } = setup()
    draftOwnedByClient.value = false
    expect(manager.state('segment.toggle-boundary').value.enabled).toBe(true)
    expect(manager.state('mark.contact').value.enabled).toBe(false)
    expect(manager.state('outcome.left').value.enabled).toBe(false)
    expect(manager.state('submission.submit').value.enabled).toBe(false)
  })

  it('keeps READY outcome and submit editable while allowing another non-overlapping Z boundary', () => {
    const { manager } = setup()
    expect(manager.state('segment.toggle-boundary').value.enabled).toBe(true)
    expect(manager.state('outcome.left').value.enabled).toBe(true)
    expect(manager.state('outcome.right').value.enabled).toBe(true)
    expect(manager.state('outcome.unknown').value.enabled).toBe(true)
    expect(manager.state('submission.submit').value.enabled).toBe(true)
  })

  it('keeps Z, outcome and submit independent from key-point selection', () => {
    const { manager, selectedKeyPointId } = setup()
    const before = {
      boundary: manager.state('segment.toggle-boundary').value,
      left: manager.state('outcome.left').value,
      submit: manager.state('submission.submit').value,
    }
    selectedKeyPointId.value = null
    expect(manager.state('segment.toggle-boundary').value).toMatchObject(before.boundary)
    expect(manager.state('outcome.left').value).toMatchObject(before.left)
    expect(manager.state('submission.submit').value).toMatchObject(before.submit)
  })

  it('keeps OPEN Z available after selecting or clearing a key point', () => {
    const { manager, selectedKeyPointId, snapshot, state } = setup()
    state.value = 'OPEN'
    snapshot.value!.snapshot.annotation_status = 'open'
    snapshot.value!.snapshot.boundaries = (snapshot.value!.snapshot.boundaries ?? []).filter(
      boundary => boundary.kind === 'start',
    )

    expect(manager.state('segment.toggle-boundary').value.enabled).toBe(true)
    selectedKeyPointId.value = null
    expect(manager.state('segment.toggle-boundary').value.enabled).toBe(true)
    selectedKeyPointId.value = 'second'
    expect(manager.state('segment.toggle-boundary').value.enabled).toBe(true)
  })

  it('blocks a new HIT outside the editable segment instead of dispatching it', async () => {
    const { manager, dispatch, selectedKeyPointId, visualPlayhead } = setup()
    selectedKeyPointId.value = null
    visualPlayhead.value = '6000'

    expect(manager.state('mark.contact').value).toMatchObject({
      enabled: false,
      reason: '目前畫格不在可編輯片段內',
    })
    expect((await manager.execute('mark.contact')).status).toBe('blocked')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes result and actor edits without creating another point', async () => {
    const { manager, setBallEvent, setBallEventActor } = setup()
    await manager.execute('mark.set-event', { kind: 'RECEIVE', result: 'SUCCESS' })
    await manager.execute('mark.set-actor', 'roster-11')
    expect(setBallEvent).toHaveBeenCalledWith('second', {
      kind: 'RECEIVE',
      result: 'SUCCESS',
    })
    expect(setBallEventActor).toHaveBeenCalledWith('second', 'roster-11')
  })

  it('serializes V and B edits through one ball-event resource lock', async () => {
    const { manager, dispatch } = setup()
    let release!: () => void
    dispatch.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )

    const success = manager.execute('mark.event-success')
    await Promise.resolve()

    expect(manager.state('mark.event-success').value.pending).toBe(true)
    expect(manager.state('mark.event-failure').value).toMatchObject({
      enabled: false,
      pending: true,
    })
    expect((await manager.execute('mark.event-failure')).status).toBe('blocked')
    expect(dispatch).toHaveBeenCalledTimes(1)

    release()
    await success
    expect(manager.state('mark.event-failure').value.enabled).toBe(true)
  })

  it('keeps direct event edits locked to the owned editable draft', () => {
    const { manager, draftOwnedByClient, snapshot } = setup()
    draftOwnedByClient.value = false
    expect(manager.state('mark.set-event').value).toMatchObject({
      enabled: false,
      reason: '此片段屬於另一個標註客戶端，只能檢視',
    })
    draftOwnedByClient.value = true
    snapshot.value!.snapshot.annotation_status = 'submitted'
    expect(manager.state('mark.set-event').value).toMatchObject({
      enabled: false,
      reason: '尚未開始可編輯片段',
    })
  })

  it('does not globally lock outcome or submission while a point update is awaiting ack', async () => {
    const { manager, setBallEvent } = setup()
    let release!: () => void
    setBallEvent.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )

    const pending = manager.execute('mark.set-event', { kind: 'RECEIVE', result: 'SUCCESS' })
    await Promise.resolve()

    expect(manager.state('mark.set-event').value.pending).toBe(true)
    expect(manager.state('outcome.left').value.enabled).toBe(true)
    expect(manager.state('submission.submit').value.enabled).toBe(true)

    release()
    await pending
  })
})
