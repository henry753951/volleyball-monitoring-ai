export type MediaBufferPreset = 'compact' | 'balanced' | 'large'

export interface MediaBufferProfile {
  label: string
  description: string
  maxBufferBytes: number
  forwardBufferSeconds: number
  backBufferSeconds: number
  requestedBackUs: string
  requestedForwardUs: string
  refreshLeadSeconds: number
}

export const MEDIA_PLAYBACK_PREFERENCES_STORAGE_KEY = 'volleyball-monitoring.media-playback.v1'
export const DEFAULT_MEDIA_BUFFER_PRESET: MediaBufferPreset = 'balanced'

export const MEDIA_BUFFER_PROFILES: Readonly<Record<MediaBufferPreset, MediaBufferProfile>> = {
  compact: {
    label: '精簡',
    description: '64 MB · 適合記憶體較少的裝置',
    maxBufferBytes: 64 * 1024 * 1024,
    forwardBufferSeconds: 90,
    backBufferSeconds: 30,
    requestedBackUs: '60000000',
    requestedForwardUs: '180000000',
    refreshLeadSeconds: 20,
  },
  balanced: {
    label: '標準',
    description: '128 MB · 播放流暢度與用量平衡',
    maxBufferBytes: 128 * 1024 * 1024,
    forwardBufferSeconds: 180,
    backBufferSeconds: 90,
    requestedBackUs: '180000000',
    requestedForwardUs: '300000000',
    refreshLeadSeconds: 40,
  },
  large: {
    label: '大型',
    description: '256 MB · 長時間回放與頻繁微調',
    maxBufferBytes: 256 * 1024 * 1024,
    forwardBufferSeconds: 300,
    backBufferSeconds: 180,
    requestedBackUs: '300000000',
    requestedForwardUs: '300000000',
    refreshLeadSeconds: 60,
  },
}

export function parseMediaBufferPreset(value: string | null | undefined): MediaBufferPreset | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { version?: unknown; bufferPreset?: unknown }
    return parsed.version === 1 &&
      typeof parsed.bufferPreset === 'string' &&
      parsed.bufferPreset in MEDIA_BUFFER_PROFILES
      ? (parsed.bufferPreset as MediaBufferPreset)
      : null
  } catch {
    return null
  }
}

export function serializeMediaBufferPreset(bufferPreset: MediaBufferPreset): string {
  return JSON.stringify({ version: 1, bufferPreset })
}
