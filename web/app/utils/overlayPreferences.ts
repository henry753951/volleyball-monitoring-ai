import type { VolleyballOverlayLayers } from './volleyballOverlayRenderer'

export const OVERLAY_PREFERENCES_STORAGE_KEY = 'volleyball.overlay.preferences.v1'

export const DEFAULT_OVERLAY_LAYERS: VolleyballOverlayLayers = {
  bbox: true,
  trackId: true,
  playerLabel: true,
  action: true,
  ball: true,
  trail: true,
  footprint: false,
  confidence: false,
  court: true,
  nextHit: true,
}

export interface OverlayPreferences {
  enabled: boolean
  layers: VolleyballOverlayLayers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

export function defaultOverlayPreferences(): OverlayPreferences {
  return {
    enabled: true,
    layers: { ...DEFAULT_OVERLAY_LAYERS },
  }
}

export function readOverlayPreferences(): OverlayPreferences {
  const defaults = defaultOverlayPreferences()
  if (typeof localStorage === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(OVERLAY_PREFERENCES_STORAGE_KEY)
    const legacyEnabled = localStorage.getItem('annotation.overlay.enabled')
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!isRecord(parsed)) {
      if (legacyEnabled !== null) defaults.enabled = legacyEnabled !== 'false'
      return defaults
    }
    const storedLayers = isRecord(parsed.layers) ? parsed.layers : {}
    defaults.enabled = readBoolean(
      parsed.enabled,
      legacyEnabled === null ? defaults.enabled : legacyEnabled !== 'false',
    )
    for (const key of Object.keys(defaults.layers) as Array<keyof VolleyballOverlayLayers>)
      defaults.layers[key] = readBoolean(storedLayers[key], defaults.layers[key])
    return defaults
  } catch {
    return defaults
  }
}

export function writeOverlayPreferences(preferences: OverlayPreferences) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(OVERLAY_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    localStorage.setItem('annotation.overlay.enabled', String(preferences.enabled))
  } catch {
    // Display preferences must never block annotation or replay.
  }
}
