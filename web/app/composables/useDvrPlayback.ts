import type Hls from 'hls.js/light'
import type { PlaybackWindowDescriptor } from './usePlaybackCursor'
import { captureTimeToPlayerSeconds, isCaptureTimeWithinWindow } from '../utils/playbackWindow'
import { boundedPlayerMediaSeconds } from '../utils/playerMediaTime'
import { useMediaPlaybackPreferences } from './useMediaPlaybackPreferences'

export function useDvrPlayback(video: Ref<HTMLVideoElement | null>) {
  const activeWindow = shallowRef<PlaybackWindowDescriptor | null>(null)
  const loading = ref(false)
  const { profile } = useMediaPlaybackPreferences()
  const prewarmed = new Map<string, Promise<void>>()
  let hls: Hls | null = null
  let generation = 0

  const prewarm = (descriptor: PlaybackWindowDescriptor) => {
    if (!import.meta.client) return Promise.resolve()
    const existing = prewarmed.get(descriptor.playback_window_id)
    if (existing) return existing
    const request = (async () => {
      const manifestUrl = new URL(descriptor.manifest_url, window.location.href)
      const response = await fetch(manifestUrl, { cache: 'force-cache', credentials: 'same-origin' })
      if (!response.ok) return
      const lines = (await response.text()).split(/\r?\n/)
      const targetSeconds = boundedPlayerMediaSeconds(descriptor.target_player_media_time_us)
      const segments: Array<{ start: number; end: number; url: URL }> = []
      let duration = 0
      let cursor = 0
      for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
          duration = Number.parseFloat(line.slice(8)) || 0
          continue
        }
        if (!line || line.startsWith('#') || duration <= 0) continue
        segments.push({ start: cursor, end: cursor + duration, url: new URL(line, manifestUrl) })
        cursor += duration
        duration = 0
      }
      const foundIndex = segments.findIndex(segment => targetSeconds >= segment.start && targetSeconds < segment.end)
      const targetIndex = foundIndex < 0 ? 0 : foundIndex
      await Promise.all(segments.slice(targetIndex, targetIndex + 3).map(segment => fetch(segment.url, {
        cache: 'force-cache',
        credentials: 'same-origin',
      }).then(() => undefined).catch(() => undefined)))
    })().catch(() => undefined)
    prewarmed.set(descriptor.playback_window_id, request)
    return request
  }

  const attach = async (descriptor: PlaybackWindowDescriptor) => {
    const element = video.value
    if (!element) throw new Error('video element is not mounted')

    const currentGeneration = ++generation
    loading.value = true
    try {
      hls?.destroy()
      hls = null
      element.removeAttribute('src')
      element.load()

      const nativeHls = element.canPlayType('application/vnd.apple.mpegurl')
      if (nativeHls) {
        // Prefer the native iPad/Safari HLS pipeline for efficiency and media controls.
        // Do not depend on browser-visible segment identifiers.
        element.src = descriptor.manifest_url
        await new Promise<void>((resolve, reject) => {
          element.addEventListener('loadedmetadata', () => resolve(), { once: true })
          element.addEventListener('error', () => reject(new Error('native HLS failed to load')), { once: true })
        })
      } else {
        // Keep the desktop HLS engine out of the Coach/PWA shell and load it only
        // when a non-native browser actually attaches a bounded DVR window.
        const { default: HlsRuntime } = await import('hls.js/light')
        if (currentGeneration !== generation) return
        if (!HlsRuntime.isSupported()) throw new Error('HLS playback is not supported by this browser')
        // Full DVR stays on the server. One manifest exposes only a bounded playback window.
        hls = new HlsRuntime({
          maxBufferSize: profile.value.maxBufferBytes,
          maxBufferLength: profile.value.forwardBufferSeconds,
          maxMaxBufferLength: profile.value.forwardBufferSeconds,
          backBufferLength: profile.value.backBufferSeconds,
          liveBackBufferLength: profile.value.backBufferSeconds,
          enableWorker: true,
        })
        hls.loadSource(descriptor.manifest_url)
        hls.attachMedia(element)
        await new Promise<void>((resolve, reject) => {
          hls!.once(HlsRuntime.Events.MANIFEST_PARSED, () => resolve())
          hls!.on(HlsRuntime.Events.ERROR, (_event, data) => {
            if (data.fatal) reject(new Error(data.details))
          })
        })
      }

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
    prewarmed.clear()
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

  return { activeWindow, loading, attach, detach, prewarm, seekCaptureTime }
}
