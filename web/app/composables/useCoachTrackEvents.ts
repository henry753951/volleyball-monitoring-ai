import type { MaybeRefOrGetter } from 'vue'
import { createCoachDomainClient, type CoachMatchAnalytics, type CoachRallyReplay } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'
import { collectCoachActionEvents } from '~/utils/coachPlayerActions'

export function useCoachTrackEvents(tracks: MaybeRefOrGetter<CoachMatchAnalytics['tracks']>) {
  const client = createCoachDomainClient(createGraphQLTransport('/graphql'))
  const replayCache = shallowReactive(new Map<string, CoachRallyReplay | null>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  let generation = 0

  const events = computed(() => collectCoachActionEvents(toValue(tracks), replayCache))

  async function refresh() {
    const currentGeneration = ++generation
    const rallyIds = [...new Set(toValue(tracks).map(track => track.rally_id))]
    const missing = rallyIds.filter(rallyId => !replayCache.has(rallyId))
    if (!missing.length) return
    pending.value = true
    error.value = null
    try {
      await Promise.all(missing.map(async (rallyId) => {
        const replay = await client.rallyReplay(rallyId)
        if (currentGeneration === generation) replayCache.set(rallyId, replay)
      }))
    }
    catch (cause) {
      if (currentGeneration === generation) error.value = cause instanceof Error ? cause : new Error('無法載入動作紀錄')
    }
    finally {
      if (currentGeneration === generation) pending.value = false
    }
  }

  watch(() => toValue(tracks).map(track => `${track.analysis_run_id}:${track.track_id}`).join('|'), () => void refresh(), { immediate: true })

  return { events, replays: readonly(replayCache), pending, error, refresh }
}
