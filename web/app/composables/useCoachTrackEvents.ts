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
) {
  const client = createCoachDomainClient(createGraphQLTransport('/graphql'))
  const replayCache = shallowReactive(new Map<string, CoachRallyReplay | null>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  let generation = 0

  const events = computed<CoachPlayerActionEvent[]>(() => {
    const selectedTracks = toValue(tracks)
    const replayEvents = collectCoachActionEvents(selectedTracks, replayCache)
    const replayByKey = new Map(
      replayEvents.map(event => [`${event.rallyId}:${event.anchorTimeUs}`, event]),
    )
    const selectedRosterEntryIds = new Set(
      selectedTracks
        .map(track => track.roster_entry_id)
        .filter((rosterEntryId): rosterEntryId is string => rosterEntryId !== null),
    )
    const canonical = toValue(canonicalEvents)
      .filter(event =>
        selectedRosterEntryIds.size
          ? event.roster_entry_id !== null && selectedRosterEntryIds.has(event.roster_entry_id)
          : selectedTracks.some(
              track =>
                event.analysis_run_id !== null &&
                event.analysis_run_id === track.analysis_run_id &&
                event.track_id === track.track_id,
            ),
      )
      .map(event => {
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

  async function refresh() {
    const currentGeneration = ++generation
    const rallyIds = [...new Set(toValue(tracks).map(track => track.rally_id))]
    const missing = rallyIds.filter(rallyId => !replayCache.has(rallyId))
    if (!missing.length) return
    pending.value = true
    error.value = null
    try {
      await Promise.all(
        missing.map(async rallyId => {
          const replay = await client.rallyReplay(rallyId)
          if (currentGeneration === generation) replayCache.set(rallyId, replay)
        }),
      )
    } catch (cause) {
      if (currentGeneration === generation)
        error.value = cause instanceof Error ? cause : new Error('無法載入人工球種紀錄')
    } finally {
      if (currentGeneration === generation) pending.value = false
    }
  }

  watch(
    () =>
      toValue(tracks)
        .map(track => `${track.analysis_run_id}:${track.track_id}`)
        .join('|'),
    () => void refresh(),
    { immediate: true },
  )

  return { events, replays: readonly(replayCache), pending, error, refresh }
}
