import {
  detectPlatform,
  matchesKeyboardEvent,
  normalizeRegisterableHotkey,
  parseHotkey,
  useHotkeyRecorder,
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
  runtimeHotkeysForBinding,
  serializeHotkeyPreferences,
  shiftedHotkeyBinding,
  toRuntimeHotkey,
  type HotkeyBindings,
  type HotkeyCommand,
} from '../utils/annotationHotkeys'

export type HotkeyCommandDispatcher = (command: HotkeyCommand, event: KeyboardEvent) => void

export function useAnnotationHotkeyRecorder(options: MaybeRefOrGetter<HotkeyRecorderOptions>) {
  return useHotkeyRecorder(options)
}

export function useAnnotationHotkeys() {
  const bindings = useState<HotkeyBindings>('annotation-hotkeys-v7', restoreDefaultHotkeys)
  const initialized = useState('annotation-hotkeys-v7-initialized', () => false)

  onMounted(() => {
    if (initialized.value) return

    const current = localStorage.getItem(HOTKEY_PREFERENCES_STORAGE_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY)
    const preferences = parseStoredHotkeyPreferences(current ?? legacy ?? '')

    if (preferences) {
      bindings.value = preferences.bindings
      localStorage.setItem(
        HOTKEY_PREFERENCES_STORAGE_KEY,
        serializeHotkeyPreferences(bindings.value),
      )
    } else if (current) {
      localStorage.removeItem(HOTKEY_PREFERENCES_STORAGE_KEY)
    }

    if (legacy) localStorage.removeItem(LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY)
    initialized.value = true
  })

  watch(
    bindings,
    value => {
      if (import.meta.client && initialized.value) {
        localStorage.setItem(HOTKEY_PREFERENCES_STORAGE_KEY, serializeHotkeyPreferences(value))
      }
    },
    { deep: true },
  )

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
  blocked?: HotkeyCommandDispatcher
  release?: HotkeyCommandDispatcher
  enabled?: MaybeRefOrGetter<boolean>
  commandEnabled?: (command: HotkeyCommand, event?: KeyboardEvent) => boolean
  scopeBlocked?: () => boolean
}

export function isModalHotkeyScopeActive(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
  return Boolean(
    document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [aria-modal="true"]'),
  )
}

export function createAnnotationHotkeyDefinitions(
  bindings: HotkeyBindings,
  dispatch: HotkeyCommandDispatcher,
  commandEnabled: (command: HotkeyCommand, event?: KeyboardEvent) => boolean = () => true,
  scopeBlocked: () => boolean = isModalHotkeyScopeActive,
  runtimeEnabled: () => boolean = () => true,
  blocked?: HotkeyCommandDispatcher,
): Array<UseHotkeyDefinition> {
  return HOTKEY_COMMANDS.flatMap(command => {
    const repeatable = command.action === 'frame_previous' || command.action === 'frame_next'
    const definition = (hotkey: ReturnType<typeof toRuntimeHotkey>): UseHotkeyDefinition => ({
      hotkey,
      callback: event => {
        if (event.isComposing || scopeBlocked() || !runtimeEnabled()) return
        if (event.repeat && !repeatable) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!commandEnabled(command.action, event)) {
          event.preventDefault()
          event.stopPropagation()
          blocked?.(command.action, event)
          return
        }
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
    const runtimes = runtimeHotkeysForBinding(bindings[command.action])
    const definitions = runtimes.map(definition)
    if (command.action === 'key_point_previous' || command.action === 'key_point_next') {
      const shiftedBinding = shiftedHotkeyBinding(bindings[command.action])
      if (shiftedBinding !== bindings[command.action]) {
        definitions.push(definition(toRuntimeHotkey(shiftedBinding)))
      }
    }
    if (!repeatable) return definitions
    const runtime = toRuntimeHotkey(bindings[command.action])
    const accelerated =
      typeof runtime === 'string' ? { key: runtime, ctrl: true } : { ...runtime, ctrl: true }
    return [...definitions, definition(accelerated)]
  })
}

export function createAnnotationHotkeyReleaseDefinitions(
  bindings: HotkeyBindings,
  release: HotkeyCommandDispatcher,
  runtimeEnabled: () => boolean = () => true,
): Array<UseHotkeyDefinition> {
  return HOTKEY_COMMANDS.flatMap(command => {
    if (command.action !== 'frame_previous' && command.action !== 'frame_next') return []
    const releaseDefinition = (
      hotkey: ReturnType<typeof toRuntimeHotkey>,
    ): UseHotkeyDefinition => ({
      hotkey,
      callback: event => {
        if (event.isComposing || !runtimeEnabled()) return
        event.preventDefault()
        event.stopPropagation()
        release(command.action, event)
      },
      options: {
        enabled: runtimeEnabled,
        eventType: 'keyup',
        requireReset: false,
        meta: {
          name: `${command.label} release`,
          description: command.group,
        },
      },
    })
    const runtimes = runtimeHotkeysForBinding(bindings[command.action])
    const runtime = toRuntimeHotkey(bindings[command.action])
    const accelerated =
      typeof runtime === 'string' ? { key: runtime, ctrl: true } : { ...runtime, ctrl: true }
    return [...runtimes.map(releaseDefinition), releaseDefinition(accelerated)]
  })
}

/**
 * Resolve a hotkey definition at the capture boundary. This deliberately does
 * not inspect focus or input-like targets: annotation commands are workstation
 * controls and must remain available while a non-modal popover, combobox or
 * selected-key-point editor owns focus.
 */
function dispatchCapturedDefinition(
  definitions: readonly UseHotkeyDefinition[],
  event: KeyboardEvent,
  eventType: 'keydown' | 'keyup',
) {
  const platform = detectPlatform()
  for (const definition of definitions) {
    const definitionOptions = definition.options ? toValue(definition.options) : {}
    if ((definitionOptions.eventType ?? 'keydown') !== eventType) continue
    const hotkey = normalizeRegisterableHotkey(toValue(definition.hotkey), platform)
    if (!matchesKeyboardEvent(event, hotkey, platform)) continue
    definition.callback(event, {
      hotkey,
      parsedHotkey: parseHotkey(hotkey, platform),
    })
    return
  }
}

/**
 * The only application boundary that registers runtime annotation hotkeys.
 * It listens on window capture so portalled popovers and focus-management
 * primitives cannot consume X/Z/etc. before the workstation sees them.
 * Modal dialogs still take precedence through scopeBlocked(), which keeps the
 * shortcut recorder and text-entry dialogs usable.
 */
export function useAnnotationHotkeyRuntime(options: AnnotationHotkeyRuntimeOptions): void {
  const { bindings } = useAnnotationHotkeys()
  const definitions = computed(() =>
    createAnnotationHotkeyDefinitions(
      bindings.value,
      options.dispatch,
      options.commandEnabled,
      options.scopeBlocked,
      () => toValue(options.enabled ?? true),
      options.blocked,
    ),
  )
  const releaseDefinitions = computed(() =>
    options.release
      ? createAnnotationHotkeyReleaseDefinitions(bindings.value, options.release, () =>
          toValue(options.enabled ?? true),
        )
      : [],
  )

  function targetAvailable() {
    return Boolean(toValue(options.target))
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!targetAvailable()) return
    dispatchCapturedDefinition(definitions.value, event, 'keydown')
  }

  function handleKeyup(event: KeyboardEvent) {
    if (!targetAvailable()) return
    dispatchCapturedDefinition(releaseDefinitions.value, event, 'keyup')
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown, true)
    window.addEventListener('keyup', handleKeyup, true)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown, true)
    window.removeEventListener('keyup', handleKeyup, true)
  })
}
