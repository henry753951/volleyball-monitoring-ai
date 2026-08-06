import {
  rebindAnnotationHotkey,
  restoreDefaultAnnotationHotkeys,
  type AnnotationAction,
  type AnnotationHotkeyBindings,
} from '~/utils/annotationHotkeys'

const STORAGE_KEY = 'volleyball-monitoring-ai:annotation-hotkeys:2'

function isCompleteBindings(value: unknown): value is AnnotationHotkeyBindings {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AnnotationHotkeyBindings>
  const actions: AnnotationAction[] = ['service', 'contact', 'close_left', 'close_right', 'close_unknown', 'submit']
  if (!actions.every((action) => typeof candidate[action] === 'string')) return false
  return new Set(actions.map((action) => candidate[action])).size === actions.length
}

export function useAnnotationHotkeys() {
  const bindings = useState<AnnotationHotkeyBindings>(
    'annotation-hotkeys-v2',
    restoreDefaultAnnotationHotkeys,
  )
  const initialized = useState('annotation-hotkeys-v2-initialized', () => false)

  onMounted(() => {
    if (!initialized.value) {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        try {
          const parsed: unknown = JSON.parse(stored)
          if (isCompleteBindings(parsed)) bindings.value = { ...parsed }
        }
        catch {
          localStorage.removeItem(STORAGE_KEY)
        }
      }
      initialized.value = true
    }
  })

  watch(bindings, (value) => {
    if (import.meta.client && initialized.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  }, { deep: true })

  function rebind(action: AnnotationAction, nextBinding: string) {
    const result = rebindAnnotationHotkey(bindings.value, action, nextBinding)
    if (result.ok) bindings.value = result.bindings
    return result
  }

  function restoreDefaults() {
    bindings.value = restoreDefaultAnnotationHotkeys()
  }

  return {
    bindings: readonly(bindings),
    rebind,
    restoreDefaults,
  }
}
