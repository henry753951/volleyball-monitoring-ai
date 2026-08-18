import type Hls from 'hls.js'
import { ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import type { OmeLivePlaybackSource } from '~/lib/omeLivePlayback'
import type { MediaBufferProfile } from '~/utils/mediaPlaybackPreferences'

interface OmeLivePlaybackOptions {
  onBufferActivity?: () => void
  onError?: (error: Error) => void
}

const ATTACH_TIMEOUT_MS = 12_000

export function requiresOmeLivePipelineReplacement(
  current: Pick<OmeLivePlaybackSource, 'captureSessionId' | 'manifestUrl'> | null,
  next: Pick<OmeLivePlaybackSource, 'captureSessionId' | 'manifestUrl'>,
) {
  return (
    current?.captureSessionId !== next.captureSessionId || current.manifestUrl !== next.manifestUrl
  )
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

  const attach = async (source: OmeLivePlaybackSource) => {
    const element = video.value
    if (!element) throw new Error('video element is not mounted')
    if (!requiresOmeLivePipelineReplacement(activeSource.value, source)) {
      activeSource.value = source
      return
    }

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
        const nextHls = new HlsRuntime({
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
        hls = nextHls
        let fatalRecoveries = 0
        const notifyBufferActivity = () => {
          fatalRecoveries = 0
          options.onBufferActivity?.()
        }
        const handleRuntimeError = (
          _event: unknown,
          data: { details: string; fatal: boolean; type: string },
        ) => {
          if (currentGeneration !== generation || !data.fatal) return
          if (fatalRecoveries < 2 && data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR) {
            fatalRecoveries += 1
            nextHls.startLoad(-1)
            return
          }
          if (fatalRecoveries < 2 && data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
            fatalRecoveries += 1
            nextHls.recoverMediaError()
            return
          }
          options.onError?.(new Error(data.details || 'OME LL-HLS playback failed'))
        }
        nextHls.on(HlsRuntime.Events.BUFFER_APPENDED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.BUFFER_FLUSHED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.FRAG_BUFFERED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.LEVEL_UPDATED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.ERROR, handleRuntimeError)
        nextHls.attachMedia(element)
        nextHls.loadSource(source.manifestUrl)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(timeoutError('manifest load')), ATTACH_TIMEOUT_MS)
          const onReady = () => finish()
          const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
            if (data.fatal) finish(new Error(data.details || 'OME LL-HLS manifest failed'))
          }
          const finish = (error?: Error) => {
            clearTimeout(timer)
            nextHls.off(HlsRuntime.Events.MANIFEST_PARSED, onReady)
            nextHls.off(HlsRuntime.Events.ERROR, onError)
            if (error) reject(error)
            else resolve()
          }
          nextHls.on(HlsRuntime.Events.MANIFEST_PARSED, onReady)
          nextHls.on(HlsRuntime.Events.ERROR, onError)
        })
        if (currentGeneration !== generation) return
        const firstFragment = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(timeoutError('first fragment')), ATTACH_TIMEOUT_MS)
          const onReady = () => finish()
          const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
            if (data.fatal) finish(new Error(data.details || 'OME LL-HLS fragment failed'))
          }
          const finish = (error?: Error) => {
            clearTimeout(timer)
            nextHls.off(HlsRuntime.Events.FRAG_BUFFERED, onReady)
            nextHls.off(HlsRuntime.Events.ERROR, onError)
            if (error) reject(error)
            else resolve()
          }
          nextHls.on(HlsRuntime.Events.FRAG_BUFFERED, onReady)
          nextHls.on(HlsRuntime.Events.ERROR, onError)
        })
        nextHls.startLoad(-1)
        await firstFragment
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

      if (currentGeneration === generation) activeSource.value = source
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
    hls.startLoad(element.currentTime > 0 ? element.currentTime : -1)
    return true
  }

  const detach = () => {
    generation += 1
    hls?.destroy()
    hls = null
    const element = video.value
    if (element) {
      element.removeAttribute('src')
      element.load()
    }
    activeSource.value = null
  }

  return { activeSource, attach, detach, loading, recover, dispose: detach }
}
