export function usePublicEndpoints() {
  const config = useRuntimeConfig()

  const toHttpUrl = (path: string) => {
    if (import.meta.server) return path
    return new URL(path, window.location.origin).toString()
  }

  const toWebSocketUrl = (path: string) => {
    if (import.meta.server) return path
    const localDevOrigin = (() => {
      if (
        !import.meta.dev ||
        window.location.protocol !== 'http:' ||
        ['', '80'].includes(window.location.port)
      ) {
        return window.location.origin
      }
      const configured = new URL(config.public.devBackendOrigin, window.location.origin)
      if (['0.0.0.0', '127.0.0.1', 'localhost'].includes(configured.hostname)) {
        configured.hostname = window.location.hostname
      }
      return configured.origin
    })()
    const url = new URL(path, localDevOrigin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  return {
    analysisReviewWsUrl: (analysisRunId: string) =>
      toWebSocketUrl(
        `${config.public.analysisReviewWsPath.replace(/\/$/, '')}/${encodeURIComponent(analysisRunId)}`,
      ),
    graphqlUrl: computed(() => toHttpUrl(config.public.graphqlPath)),
    annotationWsUrl: computed(() => toWebSocketUrl(config.public.annotationWsPath)),
    coachWsUrl: computed(() => toWebSocketUrl(config.public.coachWsPath)),
    restBaseUrl: computed(() => toHttpUrl(config.public.restBasePath)),
    liveHlsBaseUrl: computed(() => toHttpUrl(config.public.liveHlsBasePath)),
  }
}
