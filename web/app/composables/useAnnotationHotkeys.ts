import {
  useHotkeyRecorder,
  useHotkeys,
  type HotkeyRecorderOptions,
  type UseHotkeyDefinition,
} from '@tanstack/vue-hotkeys'
import { toValue, type MaybeRefOrGetter } from 'vue'
import {
  HOTKEY_COMMANDS,
  HOTKEY_PREFERENCES_STORAGE_KEY,
  LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY,
  parseStoredHotkeyPreferences,
  rebindHotkey,
  restoreDefaultHotkeys,
  serializeHotkeyPreferences,
  toRuntimeHotkey,
  type HotkeyBindings,
  type HotkeyCommand,
} from '../utils/annotationHotkeys'

export type HotkeyCommandDispatcher = (command: HotkeyCommand, event: KeyboardEvent) => void

export function useAnnotationHotkeyRecorder(
  options: MaybeRefOrGetter<HotkeyRecorderOptions>,
) {
  return useHotkeyRecorder(options)
}

export function useAnnotationHotkeys() {
  const bindings = useState<HotkeyBindings>('annotation-hotkeys-v5', restoreDefaultHotkeys)
  const initialized = useState('annotation-hotkeys-v5-initialized', () => false)

  onMounted(() => {
    if (initialized.value) return

    const current = localStorage.getItem(HOTKEY_PREFERENCES_STORAGE_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY)
    const preferences = parseStoredHotkeyPreferences(current ?? legacy ?? '')

    if (preferences) {
      bindings.value = preferences.bindings
      localStorage.setItem(HOTKEY_PREFERENCES_STORAGE_KEY, serializeHotkeyPreferences(bindings.value))
    }
    else if (current) {
      localStorage.removeItem(HOTKEY_PREFERENCES_STORAGE_KEY)
    }

    if (legacy) localStorage.removeItem(LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY)
    initialized.value = true
  })

  watch(bindings, (value) => {
    if (import.meta.client && initialized.value) {
      localStorage.setItem(HOTKEY_PREFERENCES_STORAGE_KEY, serializeHotkeyPreferences(value))
    }
  }, { deep: true })

  function rebind(action: HotkeyCommand, nextBinding: string) {
    const result = rebindHotkey(bindings.value, action, nextBinding)
    if (result.ok) bindings.value = result.bindings
    return result
  }

  function restoreDefaults() {
    bindings.value = restoreDefaultHotkeys()
  }

  return {
    bindings: readonly(bindings),
    rebind,
    restoreDefaults,
  }
}

export interface AnnotationHotkeyRuntimeOptions {
  target: MaybeRefOrGetter<HTMLElement | null>
  dispatch: HotkeyCommandDispatcher
  enabled?: MaybeRefOrGetter<boolean>
  commandEnabled?: (command: HotkeyCommand) => boolean
  scopeBlocked?: () => boolean
}

export function isModalHotkeyScopeActive(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
  return Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [aria-modal="true"]'))
}

export function createAnnotationHotkeyDefinitions(
  bindings: HotkeyBindings,
  dispatch: HotkeyCommandDispatcher,
  commandEnabled: (command: HotkeyCommand) => boolean = () => true,
  scopeBlocked: () => boolean = isModalHotkeyScopeActive,
  runtimeEnabled: () => boolean = () => true,
): Array<UseHotkeyDefinition> {
  return HOTKEY_COMMANDS.flatMap((command) => {
    const repeatable = command.action === 'frame_previous' || command.action === 'frame_next'
    const definition = (hotkey: ReturnType<typeof toRuntimeHotkey>): UseHotkeyDefinition => ({
      hotkey,
      callback: (event) => {
        if ((event.repeat && !repeatable) || event.isComposing || scopeBlocked() || !runtimeEnabled() || !commandEnabled(command.action)) return
        event.preventDefault()
        event.stopPropagation()
        dispatch(command.action, event)
      },
      options: {
        // Keep the registration active while a command is temporarily disabled.
        // TanStack must still observe keyup or requireReset can swallow the next
        // valid press after a network/state transition.
        enabled: runtimeEnabled,
        requireReset: !repeatable,
        meta: { name: command.label, description: command.group },
      },
    })
    const runtime = toRuntimeHotkey(bindings[command.action])
    if (!repeatable) return [definition(runtime)]
    const shifted = typeof runtime === 'string' ? { key: runtime, shift: true } : { ...runtime, shift: true }
    return [definition(runtime), definition(shifted)]
  })
}

/**
 * The only application boundary that registers runtime hotkeys. TanStack owns
 * the target listeners, reactive re-registration and component-unmount cleanup.
 */
export function useAnnotationHotkeyRuntime(options: AnnotationHotkeyRuntimeOptions): void {
  const { bindings } = useAnnotationHotkeys()
  const definitions = computed(() => createAnnotationHotkeyDefinitions(
    bindings.value,
    options.dispatch,
    options.commandEnabled,
    options.scopeBlocked,
    () => toValue(options.enabled ?? true),
  ))

  useHotkeys(definitions, {
    target: options.target,
    // This is the sole runtime registration boundary. Replacing a stale
    // registration makes Nuxt HMR and route remounts atomic instead of leaving
    // a dead handler that swallows the first key press.
    conflictBehavior: 'replace',
    ignoreInputs: true,
    // The callback applies these only after modal-scope precedence is checked.
    preventDefault: false,
    requireReset: false,
    stopPropagation: false,
  })
}
