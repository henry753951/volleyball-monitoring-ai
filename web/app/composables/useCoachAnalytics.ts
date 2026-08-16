import { onMounted, onUnmounted, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { createCoachDomainClient, type CoachMatchAnalytics } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

export function useCoachAnalytics(
  matchId: MaybeRefOrGetter<string>,
  options: { refreshIntervalMs?: number } = {},
) {
  const data = shallowRef<CoachMatchAnalytics | null>(null)
  const pending = ref(true)
  const refreshing = ref(false)
  const error = shallowRef<Error | null>(null)
  let interval: ReturnType<typeof setInterval> | undefined
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined
  let refreshPromise: Promise<void> | null = null
  let refreshRequested = false
  let foregroundRequested = false

  async function runRefreshLoop(background: boolean) {
    if (!background || foregroundRequested) refreshing.value = true
    try {
      do {
        refreshRequested = false
        foregroundRequested = false
        try {
          data.value = await createCoachDomainClient(createGraphQLTransport('/graphql')).analytics(
            toValue(matchId),
          )
          error.value = null
        } catch (cause) {
          error.value = cause instanceof Error ? cause : new Error('無法同步分析資料')
        }
        if (foregroundRequested) refreshing.value = true
      } while (refreshRequested)
    } finally {
      pending.value = false
      refreshing.value = false
      refreshPromise = null
    }
  }

  function requestRefresh(background: boolean) {
    if (refreshPromise) {
      refreshRequested = true
      if (!background) {
        foregroundRequested = true
        refreshing.value = true
      }
      return refreshPromise
    }
    refreshPromise = runRefreshLoop(background)
    return refreshPromise
  }

  function refresh() {
    return requestRefresh(false)
  }

  function refreshInBackground() {
    return requestRefresh(true)
  }

  function handleInvalidation(event: Event) {
    const detail = (event as CustomEvent<{ match_id?: string }>).detail
    if (detail?.match_id !== toValue(matchId)) return
    if (invalidationTimer) clearTimeout(invalidationTimer)
    invalidationTimer = setTimeout(() => void refreshInBackground(), 40)
  }

  onMounted(() => {
    void refresh()
    const refreshIntervalMs = options.refreshIntervalMs ?? 2_000
    if (refreshIntervalMs > 0)
      interval = setInterval(() => void refreshInBackground(), refreshIntervalMs)
    window.addEventListener('vollyai:match-state-invalidated', handleInvalidation)
  })
  onUnmounted(() => {
    if (interval) clearInterval(interval)
    if (invalidationTimer) clearTimeout(invalidationTimer)
    window.removeEventListener('vollyai:match-state-invalidated', handleInvalidation)
  })

  return { data, pending, refreshing, error, refresh }
}
