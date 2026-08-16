import { readonly, ref } from 'vue'
import type { createCoreDomainClient } from '~/lib/coreDomain'
import type { WorkstationFeedbackService } from './workstation-feedback.service'

type CoreDomainClient = ReturnType<typeof createCoreDomainClient>
export type WorkstationSettingsPage = 'root' | 'media' | 'overlay' | 'clip' | 'hotkeys'

const OVERLAY_STORAGE_KEY = 'annotation.overlay.enabled'

export function createWorkstationPreferencesService(options: {
  matchId: string
  core: CoreDomainClient
  feedback: WorkstationFeedbackService
  refreshCoach: () => Promise<unknown>
  onMatchUpdated?: (match: Awaited<ReturnType<CoreDomainClient['updateMatchClipPolicy']>>) => void
}) {
  const settingsOpen = ref(false)
  const settingsPage = ref<WorkstationSettingsPage>('root')
  const overlayEnabled = ref(true)
  const clipPolicySaving = ref(false)
  const clipPolicyError = ref<string | null>(null)

  function restore() {
    if (typeof localStorage === 'undefined') return
    try {
      const stored = localStorage.getItem(OVERLAY_STORAGE_KEY)
      if (stored !== null) overlayEnabled.value = stored !== 'false'
    } catch {
      // Display preferences are optional and must not block annotation setup.
    }
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
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(OVERLAY_STORAGE_KEY, String(enabled))
    } catch {
      // Display preferences must never block annotation commands.
    }
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
    clipPolicySaving: readonly(clipPolicySaving),
    clipPolicyError: readonly(clipPolicyError),
    open,
    close,
    setOverlayEnabled,
    updateClipPolicy,
    restore,
  }
}

export type WorkstationPreferencesService = ReturnType<typeof createWorkstationPreferencesService>
