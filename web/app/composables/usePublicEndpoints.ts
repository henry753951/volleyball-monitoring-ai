export function usePublicEndpoints() {
  const config = useRuntimeConfig()

  const toHttpUrl = (path: string) => {
    if (import.meta.server) return path
    return new URL(path, window.location.origin).toString()
  }

  const toWebSocketUrl = (path: string) => {
    if (import.meta.server) return path
    const url = new URL(path, window.location.origin)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  return {
    graphqlUrl: computed(() => toHttpUrl(config.public.graphqlPath)),
    annotationWsUrl: computed(() => toWebSocketUrl(config.public.annotationWsPath)),
    restBaseUrl: computed(() => toHttpUrl(config.public.restBasePath)),
    liveHlsBaseUrl: computed(() => toHttpUrl(config.public.liveHlsBasePath)),
  }
}
