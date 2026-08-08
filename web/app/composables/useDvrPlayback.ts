import type Hls from 'hls.js/light'
import type { PlaybackWindowDescriptor } from './usePlaybackCursor'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '../utils/playbackWindow'
import { boundedPlayerMediaSeconds } from '../utils/playerMediaTime'
import { useMediaPlaybackPreferences } from './useMediaPlaybackPreferences'

export function requiresPlaybackPipelineReplacement(
  current: Pick<PlaybackWindowDescriptor, 'playback_window_id'> | null,
  next: Pick<PlaybackWindowDescriptor, 'playback_window_id'>,
) {
  return current?.playback_window_id !== next.playback_window_id
}

interface DvrPlaybackOptions {
  onBufferActivity?: () => void
}

export function useDvrPlayback(video: Ref<HTMLVideoElement | null>, options: DvrPlaybackOptions = {}) {
  const activeWindow = shallowRef<PlaybackWindowDescriptor | null>(null)
  const loading = ref(false)
  const { profile } = useMediaPlaybackPreferences()
  let hls: Hls | null = null
  let generation = 0

  const attach = async (descriptor: PlaybackWindowDescriptor) => {
    const element = video.value
    if (!element) throw new Error('video element is not mounted')

    if (!requiresPlaybackPipelineReplacement(activeWindow.value, descriptor)) {
      activeWindow.value = descriptor
      return
    }

    const currentGeneration = ++generation
    loading.value = true
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
        hls = new HlsRuntime({
          autoStartLoad: false,
          maxBufferSize: profile.value.maxBufferBytes,
          maxBufferLength: profile.value.forwardBufferSeconds,
          maxMaxBufferLength: profile.value.forwardBufferSeconds,
          backBufferLength: profile.value.backBufferSeconds,
          liveBackBufferLength: profile.value.backBufferSeconds,
          // Archive uses the finite rolling playlist duration. Only a true live
          // source should expose Infinity to native media controls.
          liveDurationInfinity: descriptor.mode === 'live',
          // The bounded server archive is a rolling playlist, but it is not an
          // LL-HLS live edge. Applying live sync there overrides exact seeks.
          lowLatencyMode: descriptor.mode === 'live',
          enableWorker: true,
        })
        const notifyBufferActivity = () => options.onBufferActivity?.()
        hls.on(HlsRuntime.Events.BUFFER_APPENDED, notifyBufferActivity)
        hls.on(HlsRuntime.Events.FRAG_BUFFERED, notifyBufferActivity)
        hls.on(HlsRuntime.Events.LEVEL_UPDATED, notifyBufferActivity)
        hls.attachMedia(element)
        hls.loadSource(descriptor.manifest_url)
        await new Promise<void>((resolve, reject) => {
          hls!.once(HlsRuntime.Events.MANIFEST_PARSED, () => resolve())
          hls!.on(HlsRuntime.Events.ERROR, (_event, data) => {
            if (data.fatal) reject(new Error(data.details))
          })
        })
        if (currentGeneration !== generation) return
        const firstFragment = new Promise<void>((resolve, reject) => {
          hls!.once(HlsRuntime.Events.FRAG_BUFFERED, () => resolve())
          hls!.on(HlsRuntime.Events.ERROR, (_event, data) => {
            if (data.fatal) reject(new Error(data.details))
          })
        })
        // Explicit startLoad is required because the server intentionally keeps
        // rolling archive manifests open until the canonical source ends.
        hls.startLoad(startPosition)
        await firstFragment
      }
      else if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src = descriptor.manifest_url
        await new Promise<void>((resolve, reject) => {
          element.addEventListener('loadedmetadata', () => resolve(), { once: true })
          element.addEventListener('error', () => reject(new Error('native HLS failed to load')), { once: true })
        })
      }
      else throw new Error('HLS playback is not supported by this browser')

      if (currentGeneration !== generation) return
      activeWindow.value = descriptor
      // target_player_media_time_us is already player-local. Only this bounded
      // value may cross into Number seconds; presentation origin is canonical.
      element.currentTime = boundedPlayerMediaSeconds(descriptor.target_player_media_time_us)
    } finally {
      loading.value = false
    }
  }

  const detach = () => {
    generation += 1
    hls?.destroy(); hls = null
    const element = video.value
    if (element) { element.removeAttribute('src'); element.load() }
    activeWindow.value = null
  }

  const seekCaptureTime = async (
    captureTimeUs: bigint,
    createWindow: (targetCaptureTimeUs: string) => Promise<PlaybackWindowDescriptor>,
  ) => {
    const current = activeWindow.value
    const expiresSoon = current
      ? Date.parse(current.expires_at) <= Date.now() + 30_000
      : true

    if (
      !current
      || expiresSoon
      || !isCaptureTimeWithinWindow(captureTimeUs, current)
    ) {
      await attach(await createWindow(captureTimeUs.toString()))
      return
    }

    const element = video.value
    if (element) {
      element.currentTime = captureTimeToPlayerSeconds(captureTimeUs, current)
    }
  }

  onBeforeUnmount(detach)

  return { activeWindow, loading, attach, detach, seekCaptureTime }
}
