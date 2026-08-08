import {
  DEFAULT_MEDIA_BUFFER_PRESET,
  MEDIA_BUFFER_PROFILES,
  MEDIA_PLAYBACK_PREFERENCES_STORAGE_KEY,
  parseMediaBufferPreset,
  serializeMediaBufferPreset,
  type MediaBufferPreset,
} from '../utils/mediaPlaybackPreferences'

export function useMediaPlaybackPreferences() {
  const bufferPreset = useState<MediaBufferPreset>('media-buffer-preset-v1', () => DEFAULT_MEDIA_BUFFER_PRESET)
  const initialized = useState('media-buffer-preset-v1-initialized', () => false)

  function initialize() {
    if (initialized.value) return
    const stored = localStorage.getItem(MEDIA_PLAYBACK_PREFERENCES_STORAGE_KEY)
    const parsed = parseMediaBufferPreset(stored)
    if (parsed) bufferPreset.value = parsed
    else if (stored) localStorage.removeItem(MEDIA_PLAYBACK_PREFERENCES_STORAGE_KEY)
    initialized.value = true
  }

  // The first playback window is created during page mount. Hydrate this
  // browser-only preference before that request so the selected bounds apply
  // to the first manifest, not only the next one.
  if (import.meta.client) initialize()
  onMounted(initialize)

  watch(bufferPreset, (value) => {
    if (import.meta.client && initialized.value) {
      localStorage.setItem(MEDIA_PLAYBACK_PREFERENCES_STORAGE_KEY, serializeMediaBufferPreset(value))
    }
  })

  function setBufferPreset(value: MediaBufferPreset) {
    bufferPreset.value = value
  }

  return {
    bufferPreset: readonly(bufferPreset),
    profile: computed(() => MEDIA_BUFFER_PROFILES[bufferPreset.value]),
    setBufferPreset,
  }
}
