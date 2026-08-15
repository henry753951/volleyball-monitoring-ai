import { fetchOperationsSnapshot, type OperationsDashboardSnapshot } from '~/lib/operationsMonitor'

export function useOperationsMonitor() {
  const snapshot = useState<OperationsDashboardSnapshot | null>('operations-snapshot', () => null)
  const pending = useState('operations-pending', () => false)
  const error = useState<Error | null>('operations-error', () => null)
  const config = useRuntimeConfig()
  let timer: ReturnType<typeof setInterval> | null = null

  const refresh = async () => {
    if (pending.value) return
    pending.value = true
    try {
      snapshot.value = await fetchOperationsSnapshot(config.public.restBasePath)
      error.value = null
    } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('監控資料讀取失敗')
    } finally {
      pending.value = false
    }
  }

  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), 10_000)
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })

  return {
    snapshot: readonly(snapshot),
    pending: readonly(pending),
    error: readonly(error),
    refresh,
  }
}
