import type Hls from 'hls.js/light'
import { ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import type { PlaybackWindowDescriptor } from '~/composables/usePlaybackCursor'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '~/utils/playbackWindow'
import { boundedPlayerMediaSeconds } from '~/utils/playerMediaTime'
import type { MediaBufferProfile } from '~/utils/mediaPlaybackPreferences'
import { mediaTimeRangeContains } from '~/utils/mediaBuffer'

export function requiresPlaybackPipelineReplacement(
  current: Pick<PlaybackWindowDescriptor, 'playback_window_id'> | null,
  next: Pick<PlaybackWindowDescriptor, 'playback_window_id'>,
) {
  return current?.playback_window_id !== next.playback_window_id
}

interface DvrPlaybackOptions {
  onBufferActivity?: () => void
  onError?: (error: Error) => void
}

const ATTACH_TIMEOUT_MS = 12_000

function timeoutError(stage: string) {
  return new Error(`HLS ${stage} timed out`)
}

export function createDvrPlaybackService(
  video: Ref<HTMLVideoElement | null>,
  profile: MaybeRefOrGetter<MediaBufferProfile>,
  options: DvrPlaybackOptions = {},
) {
  const activeWindow = shallowRef<PlaybackWindowDescriptor | null>(null)
  const loading = ref(false)
  let hls: Hls | null = null
  let generation = 0

  const attach = async (descriptor: PlaybackWindowDescriptor) => {
    const element = video.value
    if (!element) throw new Error('video element is not mounted')

    if (!requiresPlaybackPipelineReplacement(activeWindow.value, descriptor)) {
      const mappingChanged = activeWindow.value?.mapping_version !== descriptor.mapping_version
      activeWindow.value = descriptor
      // Archive manifests are sealed to stop playlist polling. When the same
      // bounded window gains a mapping revision, reload that stable URL once.
      if (mappingChanged && descriptor.mode === 'archive') {
        hls?.loadSource(descriptor.manifest_url)
      }
      hls?.startLoad(Math.max(0, element.currentTime))
      return
    }

    const currentGeneration = ++generation
    loading.value = true
    activeWindow.value = null
    try {
      hls?.destroy()
      hls = null
      element.removeAttribute('src')
      element.load()

      const { default: HlsRuntime } = await import('hls.js/light')
      if (currentGeneration !== generation) return
      if (HlsRuntime.isSupported()) {
        const startPosition = boundedPlayerMediaSeconds(descriptor.target_player_media_time_us)
        // hls.js owns playlist reload, retry, eviction and fragment scheduling.
        // attachMedia creates the long-lived MediaSource/ManagedMediaSource blob.
        const nextHls = new HlsRuntime({
          autoStartLoad: false,
          maxBufferSize: toValue(profile).maxBufferBytes,
          maxBufferLength: toValue(profile).forwardBufferSeconds,
          maxMaxBufferLength: toValue(profile).forwardBufferSeconds,
          backBufferLength: toValue(profile).backBufferSeconds,
          liveBackBufferLength: toValue(profile).backBufferSeconds,
          // Archive uses the finite rolling playlist duration. Only a true live
          // source should expose Infinity to native media controls.
          liveDurationInfinity: descriptor.mode === 'live',
          // The bounded server archive is a rolling playlist, but it is not an
          // LL-HLS live edge. Applying live sync there overrides exact seeks.
          lowLatencyMode: descriptor.mode === 'live',
          ...(descriptor.mode === 'live'
            ? {
                // Stay behind the newest incomplete fragment. hls.js continues
                // reloading the stable manifest and follows newly indexed media.
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 5,
                maxLiveSyncPlaybackRate: 1.05,
              }
            : {}),
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
            nextHls.startLoad(Math.max(0, element.currentTime))
            return
          }
          if (fatalRecoveries < 2 && data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
            fatalRecoveries += 1
            nextHls.recoverMediaError()
            return
          }
          options.onError?.(new Error(data.details || 'HLS playback failed'))
        }
        nextHls.on(HlsRuntime.Events.BUFFER_APPENDED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.BUFFER_FLUSHED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.FRAG_BUFFERED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.LEVEL_UPDATED, notifyBufferActivity)
        nextHls.on(HlsRuntime.Events.ERROR, handleRuntimeError)
        nextHls.attachMedia(element)
        nextHls.loadSource(descriptor.manifest_url)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(timeoutError('manifest load')), ATTACH_TIMEOUT_MS)
          const onReady = () => finish()
          const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
            if (data.fatal) finish(new Error(data.details || 'HLS manifest failed'))
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
          const onReady = () => {
            if (mediaTimeRangeContains(element.buffered, startPosition)) finish()
          }
          const onError = (_event: unknown, data: { details: string; fatal: boolean }) => {
            if (data.fatal) finish(new Error(data.details || 'HLS fragment failed'))
          }
          const finish = (error?: Error) => {
            clearTimeout(timer)
            nextHls.off(HlsRuntime.Events.FRAG_BUFFERED, onReady)
            nextHls.off(HlsRuntime.Events.BUFFER_APPENDED, onReady)
            nextHls.off(HlsRuntime.Events.ERROR, onError)
            if (error) reject(error)
            else resolve()
          }
          nextHls.on(HlsRuntime.Events.FRAG_BUFFERED, onReady)
          nextHls.on(HlsRuntime.Events.BUFFER_APPENDED, onReady)
          nextHls.on(HlsRuntime.Events.ERROR, onError)
        })
        // Explicit startLoad is required because the server intentionally keeps
        // rolling archive manifests open until the canonical source ends.
        nextHls.startLoad(startPosition)
        await firstFragment
      } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src = descriptor.manifest_url
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => finish(timeoutError('native manifest load')),
            ATTACH_TIMEOUT_MS,
          )
          const onReady = () => finish()
          const onError = () => finish(new Error('native HLS failed to load'))
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

      if (currentGeneration !== generation) return
      activeWindow.value = descriptor
      // target_player_media_time_us is already player-local. Only this bounded
      // value may cross into Number seconds; presentation origin is canonical.
      element.currentTime = boundedPlayerMediaSeconds(descriptor.target_player_media_time_us)
    } catch (error) {
      if (currentGeneration === generation) {
        hls?.destroy()
        hls = null
        activeWindow.value = null
      }
      throw error
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  const recover = () => {
    const element = video.value
    if (!element || !activeWindow.value || !hls) return false
    hls.startLoad(Math.max(0, element.currentTime))
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
    activeWindow.value = null
  }

  const seekCaptureTime = async (
    captureTimeUs: bigint,
    createWindow: (targetCaptureTimeUs: string) => Promise<PlaybackWindowDescriptor>,
  ) => {
    const current = activeWindow.value
    const expiresSoon = current ? Date.parse(current.expires_at) <= Date.now() + 30_000 : true

    if (!current || expiresSoon || !isCaptureTimeWithinWindow(captureTimeUs, current)) {
      await attach(await createWindow(captureTimeUs.toString()))
      return
    }

    const element = video.value
    if (element) {
      element.currentTime = captureTimeToPlayerSeconds(captureTimeUs, current)
    }
  }

  return { activeWindow, loading, attach, detach, recover, seekCaptureTime, dispose: detach }
}
