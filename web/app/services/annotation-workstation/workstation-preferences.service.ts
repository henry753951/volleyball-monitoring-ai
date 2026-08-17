import { readonly, ref } from 'vue'
import type { createCoreDomainClient } from '~/lib/coreDomain'
import type { WorkstationFeedbackService } from './workstation-feedback.service'
import { readOverlayPreferences, writeOverlayPreferences } from '~/utils/overlayPreferences'
import type { VolleyballOverlayLayers } from '~/utils/volleyballOverlayRenderer'

type CoreDomainClient = ReturnType<typeof createCoreDomainClient>
export type WorkstationSettingsPage = 'root' | 'media' | 'overlay' | 'clip' | 'hotkeys'

type OverlayLayerKey = keyof VolleyballOverlayLayers

export function createWorkstationPreferencesService(options: {
  matchId: string
  core: CoreDomainClient
  feedback: WorkstationFeedbackService
  refreshCoach: () => Promise<unknown>
  onMatchUpdated?: (match: Awaited<ReturnType<CoreDomainClient['updateMatchClipPolicy']>>) => void
}) {
  const settingsOpen = ref(false)
  const settingsPage = ref<WorkstationSettingsPage>('root')
  const initialOverlayPreferences = readOverlayPreferences()
  const overlayEnabled = ref(initialOverlayPreferences.enabled)
  const overlayLayers = ref({ ...initialOverlayPreferences.layers })
  const clipPolicySaving = ref(false)
  const clipPolicyError = ref<string | null>(null)

  function restore() {
    const preferences = readOverlayPreferences()
    overlayEnabled.value = preferences.enabled
    overlayLayers.value = { ...preferences.layers }
  }

  function open(page: WorkstationSettingsPage = 'root') {
    settingsPage.value = page
    settingsOpen.value = true
  }

  function close() {
    settingsOpen.value = false
  }

  function setOverlayEnabled(enabled: boolean) {
    overlayEnabled.value = enabled
    writeOverlayPreferences({ enabled, layers: { ...overlayLayers.value } })
  }

  function setOverlayLayer(key: OverlayLayerKey, enabled: boolean) {
    overlayLayers.value[key] = enabled
    writeOverlayPreferences({
      enabled: overlayEnabled.value,
      layers: { ...overlayLayers.value },
    })
  }

  async function updateClipPolicy(preRollSeconds: number, postRollSeconds: number) {
    if (clipPolicySaving.value) return
    clipPolicySaving.value = true
    clipPolicyError.value = null
    try {
      const match = await options.core.updateMatchClipPolicy({
        matchId: options.matchId,
        preRollSeconds,
        postRollSeconds,
      })
      options.onMatchUpdated?.(match)
      await options.refreshCoach()
      options.feedback.notify({ level: 'success', title: '片段範圍已更新' })
    } catch (cause) {
      clipPolicyError.value = cause instanceof Error ? cause.message : '片段範圍儲存失敗'
    } finally {
      clipPolicySaving.value = false
    }
  }

  restore()

  return {
    settingsOpen: readonly(settingsOpen),
    settingsPage: readonly(settingsPage),
    overlayEnabled: readonly(overlayEnabled),
    overlayLayers: readonly(overlayLayers),
    clipPolicySaving: readonly(clipPolicySaving),
    clipPolicyError: readonly(clipPolicyError),
    open,
    close,
    setOverlayEnabled,
    setOverlayLayer,
    updateClipPolicy,
    restore,
  }
}

export type WorkstationPreferencesService = ReturnType<typeof createWorkstationPreferencesService>
