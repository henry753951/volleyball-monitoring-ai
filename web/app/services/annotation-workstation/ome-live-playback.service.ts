import type Hls from 'hls.js'
import { ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import type { OmeLivePlaybackSource } from '~/lib/omeLivePlayback'
import type { MediaBufferProfile } from '~/utils/mediaPlaybackPreferences'

interface OmeLivePlaybackOptions {
  attachRetryWindowMs?: number
  onBufferActivity?: () => void
  onError?: (error: Error) => void
  retryDelayMs?: (attempt: number) => number
}

const ATTACH_TIMEOUT_MS = 12_000
const ATTACH_RETRY_WINDOW_MS = 45_000

export function omeLiveAttachRetryDelayMs(attempt: number) {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt))
}

export function requiresOmeLivePipelineReplacement(
  current: Pick<OmeLivePlaybackSource, 'captureSessionId' | 'manifestUrl'> | null,
  next: Pick<OmeLivePlaybackSource, 'captureSessionId' | 'manifestUrl'>,
) {
  return (
    current?.captureSessionId !== next.captureSessionId || current.manifestUrl !== next.manifestUrl
  )
}

export function requiresOmeLiveMasterReload(data: {
  details?: string
  response?: { code?: number }
}) {
  const status = data.response?.code
  if (status === 404 || status === 410) return true
  return new Set([
    'audioTrackLoadError',
    'audioTrackLoadTimeOut',
    'levelEmptyError',
    'levelLoadError',
    'levelLoadTimeOut',
    'levelParsingError',
  ]).has(data.details ?? '')
}

function timeoutError(stage: string) {
  return new Error(`OME LL-HLS ${stage} timed out`)
}

export function createOmeLivePlaybackService(
  video: Ref<HTMLVideoElement | null>,
  profile: MaybeRefOrGetter<MediaBufferProfile>,
  options: OmeLivePlaybackOptions = {},
) {
  const activeSource = shallowRef<OmeLivePlaybackSource | null>(null)
  const loading = ref(false)
  let hls: Hls | null = null
  let generation = 0
  let intentElement: HTMLVideoElement | null = null
  let playbackRequested = false

  const handleIntentPlay = () => {
    playbackRequested = true
  }
  const handleIntentPause = () => {
    // Loading a replacement MediaSource pauses the element after readyState
    // has already dropped to HAVE_NOTHING. Preserve the operator's play intent
    // across that transport-only pause, but remember a real pause on loaded media.
    if (intentElement && intentElement.readyState >= 2) playbackRequested = false
  }
  const observePlaybackIntent = (element: HTMLVideoElement) => {
    if (intentElement === element) return
    intentElement?.removeEventListener('play', handleIntentPlay)
    intentElement?.removeEventListener('pause', handleIntentPause)
    intentElement = element
    intentElement.addEventListener('play', handleIntentPlay)
    intentElement.addEventListener('pause', handleIntentPause)
  }

  const waitForRetry = (delayMs: number) =>
    new Promise<void>(resolve => setTimeout(resolve, delayMs))

  const attach = async (source: OmeLivePlaybackSource) => {
    const element = video.value
    if (!element) throw new Error('video element is not mounted')
    observePlaybackIntent(element)
    if (!requiresOmeLivePipelineReplacement(activeSource.value, source)) {
      activeSource.value = source
      return
    }
    const shouldResume = playbackRequested || (!element.paused && !element.ended)

    const currentGeneration = ++generation
    loading.value = true
    activeSource.value = null
    try {
      hls?.destroy()
      hls = null
      element.removeAttribute('src')
      element.load()

      // OME publishes audio as an alternate rendition. The hls.js light
      // build omits the alternate-audio controller, so the direct OME path
      // must use the full runtime even though legacy manifests do not.
      const { default: HlsRuntime } = await import('hls.js')
      if (currentGeneration !== generation) return
      if (HlsRuntime.isSupported()) {
        const retryStartedAt = Date.now()
        let attachAttempt = 0
        let nextHls: Hls | null = null
        while (currentGeneration === generation) {
          try {
            nextHls?.destroy()
            const attemptHls = new HlsRuntime({
              autoStartLoad: false,
              backBufferLength: toValue(profile).backBufferSeconds,
              liveBackBufferLength: toValue(profile).backBufferSeconds,
              liveDurationInfinity: true,
              lowLatencyMode: true,
              liveSyncDurationCount: 2,
              // Do not force a rewound DVR playhead back to the live edge. The
              // operator decides when to return live; automatic latency catch-up
              // would make pause/rewind unusable for annotation.
              maxLiveSyncPlaybackRate: 1,
              maxBufferLength: toValue(profile).forwardBufferSeconds,
              maxBufferSize: toValue(profile).maxBufferBytes,
              maxMaxBufferLength: toValue(profile).forwardBufferSeconds,
              enableWorker: true,
            })
            nextHls = attemptHls
            hls = attemptHls
            let fatalRecoveries = 0
            let runtimeRecoveryStarted = false
            const notifyBufferActivity = () => {
              fatalRecoveries = 0
              options.onBufferActivity?.()
            }
            const handleRuntimeError = (
              _event: unknown,
              data: {
                details: string
                fatal: boolean
                response?: { code?: number }
                type: string
              },
            ) => {
              if (currentGeneration !== generation) return
              if (requiresOmeLiveMasterReload(data)) {
                if (runtimeRecoveryStarted) return
                runtimeRecoveryStarted = true
                attemptHls.destroy()
                if (hls === attemptHls) hls = null
                activeSource.value = null
                void attach(source).catch(error =>
                  options.onError?.(
                    error instanceof Error ? error : new Error('OME LL-HLS playback failed'),
                  ),
                )
                return
              }
              if (!data.fatal) return
              if (fatalRecoveries < 2 && data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR) {
                fatalRecoveries += 1
                if (!element.paused && !element.ended) element.pause()
                attemptHls.startLoad(-1)
                return
              }
              if (fatalRecoveries < 2 && data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
                fatalRecoveries += 1
                if (!element.paused && !element.ended) element.pause()
                attemptHls.recoverMediaError()
                return
              }
              if (runtimeRecoveryStarted) return
              runtimeRecoveryStarted = true
              attemptHls.destroy()
              if (hls === attemptHls) hls = null
              activeSource.value = null
              void attach(source).catch(error =>
                options.onError?.(
                  error instanceof Error ? error : new Error('OME LL-HLS playback failed'),
                ),
              )
            }
            attemptHls.on(HlsRuntime.Events.BUFFER_APPENDED, notifyBufferActivity)
            attemptHls.on(HlsRuntime.Events.BUFFER_FLUSHED, notifyBufferActivity)
            attemptHls.on(HlsRuntime.Events.FRAG_BUFFERED, notifyBufferActivity)
            attemptHls.on(HlsRuntime.Events.LEVEL_UPDATED, notifyBufferActivity)
            attemptHls.on(HlsRuntime.Events.ERROR, handleRuntimeError)
            attemptHls.attachMedia(element)
            attemptHls.loadSource(source.manifestUrl)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => finish(timeoutError('manifest load')),
                ATTACH_TIMEOUT_MS,
              )
              const onReady = () => finish()
              const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
                if (data.fatal) finish(new Error(data.details || 'OME LL-HLS manifest failed'))
              }
              const finish = (error?: Error) => {
                clearTimeout(timer)
                attemptHls.off(HlsRuntime.Events.MANIFEST_PARSED, onReady)
                attemptHls.off(HlsRuntime.Events.ERROR, onError)
                if (error) reject(error)
                else resolve()
              }
              attemptHls.on(HlsRuntime.Events.MANIFEST_PARSED, onReady)
              attemptHls.on(HlsRuntime.Events.ERROR, onError)
            })
            if (currentGeneration !== generation) return
            const firstFragment = new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => finish(timeoutError('first fragment')),
                ATTACH_TIMEOUT_MS,
              )
              const onReady = () => finish()
              const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
                if (data.fatal) finish(new Error(data.details || 'OME LL-HLS fragment failed'))
              }
              const finish = (error?: Error) => {
                clearTimeout(timer)
                attemptHls.off(HlsRuntime.Events.FRAG_BUFFERED, onReady)
                attemptHls.off(HlsRuntime.Events.ERROR, onError)
                if (error) reject(error)
                else resolve()
              }
              attemptHls.on(HlsRuntime.Events.FRAG_BUFFERED, onReady)
              attemptHls.on(HlsRuntime.Events.ERROR, onError)
            })
            attemptHls.startLoad(-1)
            await firstFragment
            break
          } catch (error) {
            nextHls?.destroy()
            if (hls === nextHls) hls = null
            if (currentGeneration !== generation) return
            const retryDelay = (options.retryDelayMs ?? omeLiveAttachRetryDelayMs)(attachAttempt)
            const retryWindow = options.attachRetryWindowMs ?? ATTACH_RETRY_WINDOW_MS
            if (Date.now() - retryStartedAt + retryDelay > retryWindow) throw error
            attachAttempt += 1
            await waitForRetry(retryDelay)
          }
        }
      } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src = source.manifestUrl
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => finish(timeoutError('native manifest load')),
            ATTACH_TIMEOUT_MS,
          )
          const onReady = () => finish()
          const onError = () => finish(new Error('native OME LL-HLS failed to load'))
          const finish = (error?: Error) => {
            clearTimeout(timer)
            element.removeEventListener('loadedmetadata', onReady)
            element.removeEventListener('error', onError)
            if (error) reject(error)
            else resolve()
          }
          element.addEventListener('loadedmetadata', onReady)
          element.addEventListener('error', onError)
        })
      } else throw new Error('HLS playback is not supported by this browser')

      if (currentGeneration === generation) {
        activeSource.value = source
        if (shouldResume) await element.play().catch(() => undefined)
      }
    } catch (error) {
      if (currentGeneration === generation) {
        hls?.destroy()
        hls = null
        activeSource.value = null
      }
      throw error
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  const recover = () => {
    const element = video.value
    if (!element || !activeSource.value || !hls) return false
    const resumePlayback = !element.paused && !element.ended
    if (resumePlayback) element.pause()
    hls.startLoad(element.currentTime > 0 ? element.currentTime : -1)
    if (resumePlayback) void element.play().catch(() => undefined)
    return true
  }

  const playingDate = () => hls?.playingDate ?? null

  const detach = () => {
    generation += 1
    hls?.destroy()
    hls = null
    const element = video.value
    if (element) {
      element.removeAttribute('src')
      element.load()
    }
    intentElement?.removeEventListener('play', handleIntentPlay)
    intentElement?.removeEventListener('pause', handleIntentPause)
    intentElement = null
    playbackRequested = false
    activeSource.value = null
  }

  return { activeSource, attach, detach, loading, playingDate, recover, dispose: detach }
}
