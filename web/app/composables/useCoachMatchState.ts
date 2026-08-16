import { onMounted, onUnmounted, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { createGraphQLTransport } from '~/lib/coreDomain'
import { createCoachDomainClient, type CoachMatchState } from '~/lib/coachDomain'

export function useCoachMatchState(
  matchId: MaybeRefOrGetter<string>,
  options: { refreshIntervalMs?: number } = {},
) {
  const data = shallowRef<CoachMatchState | null>(null)
  const pending = ref(true)
  const refreshing = ref(false)
  const error = shallowRef<Error | null>(null)
  const lastUpdatedAt = ref<Date | null>(null)
  let interval: ReturnType<typeof setInterval> | undefined
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined
  let refreshPromise: Promise<void> | null = null
  let refreshRequested = false

  async function runRefreshLoop() {
    refreshing.value = true
    try {
      do {
        refreshRequested = false
        try {
          data.value = await createCoachDomainClient(createGraphQLTransport('/graphql')).matchState(
            toValue(matchId),
          )
          error.value = null
          lastUpdatedAt.value = new Date()
        } catch (cause) {
          error.value = cause instanceof Error ? cause : new Error('無法同步教練面板')
        }
      } while (refreshRequested)
    } finally {
      pending.value = false
      refreshing.value = false
      refreshPromise = null
    }
  }

  function refresh() {
    if (refreshPromise) {
      refreshRequested = true
      return refreshPromise
    }
    refreshPromise = runRefreshLoop()
    return refreshPromise
  }

  function handleInvalidation(event: Event) {
    const detail = (event as CustomEvent<{ match_id?: string }>).detail
    if (detail?.match_id !== toValue(matchId)) return
    if (invalidationTimer) clearTimeout(invalidationTimer)
    invalidationTimer = setTimeout(() => void refresh(), 40)
  }

  onMounted(() => {
    void refresh()
    const refreshIntervalMs = options.refreshIntervalMs ?? 2_000
    if (refreshIntervalMs > 0) interval = setInterval(() => void refresh(), refreshIntervalMs)
    window.addEventListener('vollyai:match-state-invalidated', handleInvalidation)
  })
  onUnmounted(() => {
    if (interval) clearInterval(interval)
    if (invalidationTimer) clearTimeout(invalidationTimer)
    window.removeEventListener('vollyai:match-state-invalidated', handleInvalidation)
  })

  return { data, pending, refreshing, error, lastUpdatedAt, refresh }
}
