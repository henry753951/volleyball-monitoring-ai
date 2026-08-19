import type { MaybeRefOrGetter } from 'vue'
import {
  createCoachDomainClient,
  type CoachMatchAnalytics,
  type CoachRallyReplay,
} from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'
import {
  actionDisplayLabel,
  collectCoachActionEvents,
  type CoachPlayerActionEvent,
} from '~/utils/coachPlayerActions'

type CanonicalActionEvent = NonNullable<CoachMatchAnalytics['action_events']>[number]

export function useCoachTrackEvents(
  tracks: MaybeRefOrGetter<CoachMatchAnalytics['tracks']>,
  canonicalEvents: MaybeRefOrGetter<CanonicalActionEvent[]> = () => [],
  selectedRosterEntryIds: MaybeRefOrGetter<string[]> = () => [],
) {
  const client = createCoachDomainClient(createGraphQLTransport('/graphql'))
  const replayCache = shallowReactive(new Map<string, CoachRallyReplay | null>())
  const loadingRallyIds = shallowReactive(new Set<string>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)

  const scopedCanonicalEvents = computed(() => {
    const selectedTracks = toValue(tracks)
    const rosterEntryIds = new Set(toValue(selectedRosterEntryIds))
    const trackRosterEntryIds = new Set(
      selectedTracks
        .map(track => track.roster_entry_id)
        .filter((rosterEntryId): rosterEntryId is string => rosterEntryId !== null),
    )
    return toValue(canonicalEvents).filter(event =>
      rosterEntryIds.size || trackRosterEntryIds.size
        ? event.roster_entry_id !== null &&
          (rosterEntryIds.has(event.roster_entry_id) ||
            trackRosterEntryIds.has(event.roster_entry_id))
        : selectedTracks.some(
            track =>
              event.analysis_run_id !== null &&
              event.analysis_run_id === track.analysis_run_id &&
              event.track_id === track.track_id,
          ),
    )
  })

  const events = computed<CoachPlayerActionEvent[]>(() => {
    const selectedTracks = toValue(tracks)
    const replayEvents = collectCoachActionEvents(selectedTracks, replayCache)
    const replayByKey = new Map(
      replayEvents.map(event => [`${event.rallyId}:${event.anchorTimeUs}`, event]),
    )
    const canonical = scopedCanonicalEvents.value.map(event => {
      const replay = replayByKey.get(`${event.rally_id}:${event.anchor_time_us}`)
      const resultKey: CoachPlayerActionEvent['resultKey'] =
        event.result_key === 'success' || event.result_key === 'failure' ? event.result_key : null
      return {
        id: event.id,
        rallyId: event.rally_id,
        setNumber: event.set_number,
        rallyOrdinal: event.rally_ordinal,
        analysisRunId: event.analysis_run_id ?? 'human-ball-event',
        trackId: event.track_id ?? -1,
        anchorTimeUs: event.anchor_time_us,
        actionKey: event.action_key,
        actionLabel: event.action_key === 'hit' ? 'HIT' : actionDisplayLabel(event.action_key),
        actionConfidence: event.action_confidence,
        resultKey,
        routeStart: event.route_start ?? replay?.routeStart ?? null,
        routeEnd: event.route_end ?? replay?.routeEnd ?? null,
        courtSide: (event.court_side === 'left' || event.court_side === 'right'
          ? event.court_side
          : replay?.courtSide) as CoachPlayerActionEvent['courtSide'],
        outcome: event.outcome,
      }
    })
    const visibleEvents = canonical.length ? canonical : replayEvents
    return visibleEvents.sort(
      (left, right) =>
        left.setNumber - right.setNumber ||
        left.rallyOrdinal - right.rallyOrdinal ||
        Number(BigInt(left.anchorTimeUs) - BigInt(right.anchorTimeUs)),
    )
  })

  async function loadReplay(rallyId: string) {
    if (replayCache.has(rallyId)) return replayCache.get(rallyId) ?? null
    if (loadingRallyIds.has(rallyId)) return null
    loadingRallyIds.add(rallyId)
    pending.value = true
    error.value = null
    try {
      const replay = await client.rallyReplay(rallyId)
      replayCache.set(rallyId, replay)
      return replay
    } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('無法載入人工球種紀錄')
      replayCache.set(rallyId, null)
      return null
    } finally {
      loadingRallyIds.delete(rallyId)
      pending.value = loadingRallyIds.size > 0
    }
  }

  async function refresh() {
    await Promise.all(
      [...new Set(toValue(tracks).map(track => track.rally_id))]
        .filter(rallyId => !replayCache.has(rallyId))
        .map(rallyId => loadReplay(rallyId)),
    )
  }

  watch(
    () =>
      toValue(tracks)
        .map(track => `${track.analysis_run_id}:${track.track_id}`)
        .join('|'),
    () => void refresh(),
    { immediate: true },
  )

  return {
    events,
    replays: readonly(replayCache),
    pending,
    error,
    refresh,
    loadReplay,
    isReplayLoading: (rallyId: string) => loadingRallyIds.has(rallyId),
  }
}
