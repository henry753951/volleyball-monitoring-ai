import {
  createCoreDomainClient,
  createGraphQLTransport,
  type CreateMatchSetupInput,
  type Match,
  type Viewer,
} from '../lib/coreDomain'

export function useCoreDomain() {
  const config = useRuntimeConfig()
  const client = createCoreDomainClient(createGraphQLTransport(config.public.graphqlPath))
  return client
}

export function useViewerState() {
  const viewer = useState<Viewer | null>('core-viewer', () => null)
  const pending = useState('core-viewer-pending', () => false)
  const error = useState<Error | null>('core-viewer-error', () => null)
  const checked = useState('core-viewer-checked', () => false)

  const refresh = async () => {
    pending.value = true
    error.value = null
    try {
      viewer.value = await useCoreDomain().viewer()
      checked.value = true
      return viewer.value
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('無法驗證登入狀態')
      checked.value = true
      return null
    }
    finally {
      pending.value = false
    }
  }

  return { viewer: readonly(viewer), pending: readonly(pending), error: readonly(error), checked: readonly(checked), refresh }
}

export function useMatches() {
  const matches = useState<Match[]>('core-matches', () => [])
  const pending = useState('core-matches-pending', () => false)
  const error = useState<Error | null>('core-matches-error', () => null)

  const refresh = async () => {
    pending.value = true
    error.value = null
    try {
      matches.value = await useCoreDomain().matches()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('無法載入場次')
    }
    finally {
      pending.value = false
    }
  }

  return { matches: readonly(matches), pending: readonly(pending), error: readonly(error), refresh }
}

export function useCreateMatchSetup() {
  const pending = ref(false)
  const error = ref<Error | null>(null)
  const create = async (input: CreateMatchSetupInput) => {
    if (pending.value) throw new Error('請等待目前的建立作業完成')
    pending.value = true
    error.value = null
    try {
      return await useCoreDomain().createMatchSetup(input)
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause : new Error('建立場次失敗')
      throw error.value
    }
    finally {
      pending.value = false
    }
  }
  return { pending: readonly(pending), error: readonly(error), create }
}
