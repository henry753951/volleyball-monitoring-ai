import {
  formatForDisplay,
  hasNonModifierKey,
  normalizeHotkey,
  validateHotkey,
  type FormatDisplayOptions,
  type Hotkey,
  type RegisterableHotkey,
} from '@tanstack/vue-hotkeys'

export type AnnotationAction =
  | 'service'
  | 'contact'
  | 'close_left'
  | 'close_right'
  | 'close_unknown'
  | 'submit'

export type MediaAction = 'frame_previous' | 'frame_next'
export type HotkeyCommand = AnnotationAction | MediaAction
export type HotkeyCommandGroup = 'annotation' | 'media'
export type HotkeyBindings = Record<HotkeyCommand, string>

export interface HotkeyCommandDefinition {
  action: HotkeyCommand
  group: HotkeyCommandGroup
  label: string
  description?: string
}

export const ANNOTATION_COMMANDS = [
  { action: 'service', group: 'annotation', label: '發球' },
  { action: 'contact', group: 'annotation', label: '擊球' },
  {
    action: 'close_left',
    group: 'annotation',
    label: '左側得分',
    description: 'CLOSE_RALLY：terminalize最後key point並保存rally outcome',
  },
  {
    action: 'close_right',
    group: 'annotation',
    label: '右側得分',
    description: 'CLOSE_RALLY：terminalize最後key point並保存rally outcome',
  },
  {
    action: 'close_unknown',
    group: 'annotation',
    label: '未知',
    description: 'CLOSE_RALLY：terminalize最後key point並保存rally outcome',
  },
  { action: 'submit', group: 'annotation', label: '提交' },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const MEDIA_COMMANDS = [
  { action: 'frame_previous', group: 'media', label: '上一幀' },
  { action: 'frame_next', group: 'media', label: '下一幀' },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const HOTKEY_COMMANDS: ReadonlyArray<HotkeyCommandDefinition> = [
  ...ANNOTATION_COMMANDS,
  ...MEDIA_COMMANDS,
]

export const HOTKEY_PREFERENCES_VERSION = 3 as const
export const HOTKEY_PREFERENCES_STORAGE_KEY = 'volleyball-monitoring-ai:hotkeys:3'
export const LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY = 'volleyball-monitoring-ai:annotation-hotkeys:2'

export const DEFAULT_HOTKEY_BINDINGS: Readonly<HotkeyBindings> = Object.freeze({
  service: 'Z',
  contact: 'Space',
  close_left: '<',
  close_right: '>',
  close_unknown: '?',
  submit: 'Enter',
  frame_previous: 'ArrowLeft',
  frame_next: 'ArrowRight',
})

const SHIFTED_PRODUCT_KEYS = new Set(['<', '>', '?'])

const BROWSER_RESERVED_HOTKEYS = [
  'Mod+L',
  'Mod+R',
  'Mod+T',
  'Mod+W',
  'Mod+N',
  'Mod+Shift+N',
  'Mod+P',
  'Mod+S',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'F5',
  'F11',
  'F12',
] as const

export interface StoredHotkeyPreferences {
  version: typeof HOTKEY_PREFERENCES_VERSION
  bindings: HotkeyBindings
}

export type RebindResult =
  | { ok: true, bindings: HotkeyBindings }
  | {
      ok: false
      bindings: HotkeyBindings
      reason: 'conflict' | 'invalid' | 'reserved'
      conflictWith?: HotkeyCommand
    }

export function restoreDefaultHotkeys(): HotkeyBindings {
  return { ...DEFAULT_HOTKEY_BINDINGS }
}

/**
 * TanStack records shifted printable characters as `Shift+<`, `Shift+>` and
 * `Shift+?`. The product contract names those physical bindings by the
 * resulting character, so preferences keep the compact form.
 */
export function normalizeRecordedHotkey(
  hotkey: string,
  platform?: 'mac' | 'windows' | 'linux',
): string | null {
  if (!hotkey.trim()) return null
  const normalized = normalizeHotkey(hotkey, platform)
  const shiftedCharacter = normalized.match(/^Shift\+([<>?])$/)?.[1]
  const productBinding = shiftedCharacter ?? normalized
  const validation = validateHotkey(productBinding)
  return validation.valid && hasNonModifierKey(productBinding) ? productBinding : null
}

/** Expand product-character defaults into registrations that match real keydown modifiers. */
export function toRuntimeHotkey(binding: string): RegisterableHotkey {
  if (SHIFTED_PRODUCT_KEYS.has(binding)) {
    return { key: binding, shift: true }
  }
  return binding as Hotkey
}

export function formatBindingForDisplay(
  binding: string,
  options: FormatDisplayOptions = {},
): string {
  return formatForDisplay(binding, options)
}

function bindingMatchesOnEitherPlatform(left: string, right: string): boolean {
  return (['mac', 'windows'] as const).some((platform) =>
    normalizeRuntimeBinding(left, platform) === normalizeRuntimeBinding(right, platform))
}

function normalizeRuntimeBinding(
  binding: string,
  platform: 'mac' | 'windows' | 'linux',
): string {
  const runtime = toRuntimeHotkey(binding)
  if (typeof runtime === 'string') return normalizeHotkey(runtime, platform)
  const modifiers = [
    runtime.ctrl ? 'Control' : null,
    runtime.alt ? 'Alt' : null,
    runtime.shift ? 'Shift' : null,
    runtime.meta ? 'Meta' : null,
    runtime.mod ? 'Mod' : null,
  ].filter(Boolean)
  return normalizeHotkey([...modifiers, runtime.key].join('+'), platform)
}

export function isBrowserReservedHotkey(binding: string): boolean {
  return BROWSER_RESERVED_HOTKEYS.some((reserved) =>
    bindingMatchesOnEitherPlatform(binding, reserved))
}

export function rebindHotkey(
  bindings: HotkeyBindings,
  action: HotkeyCommand,
  recordedHotkey: string,
): RebindResult {
  const nextBinding = normalizeRecordedHotkey(recordedHotkey)
  if (!nextBinding) return { ok: false, reason: 'invalid', bindings }
  if (isBrowserReservedHotkey(nextBinding)) {
    return { ok: false, reason: 'reserved', bindings }
  }

  const conflict = HOTKEY_COMMANDS.find((command) =>
    command.action !== action
      && bindingMatchesOnEitherPlatform(bindings[command.action], nextBinding))
  if (conflict) {
    return {
      ok: false,
      reason: 'conflict',
      conflictWith: conflict.action,
      bindings,
    }
  }

  return { ok: true, bindings: { ...bindings, [action]: nextBinding } }
}

export function commandForBinding(
  binding: string,
  bindings: HotkeyBindings,
): HotkeyCommand | null {
  return HOTKEY_COMMANDS.find((command) =>
    bindingMatchesOnEitherPlatform(bindings[command.action], binding))?.action ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeBindingRecord(
  value: Record<string, unknown>,
  commands: ReadonlyArray<HotkeyCommandDefinition>,
): HotkeyBindings | null {
  const bindings = restoreDefaultHotkeys()

  for (const command of commands) {
    const raw = value[command.action]
    if (typeof raw !== 'string') return null
    const normalized = normalizeRecordedHotkey(raw)
    if (!normalized || isBrowserReservedHotkey(normalized)) return null
    bindings[command.action] = normalized
  }

  for (const [index, command] of HOTKEY_COMMANDS.entries()) {
    for (const other of HOTKEY_COMMANDS.slice(index + 1)) {
      if (bindingMatchesOnEitherPlatform(bindings[command.action], bindings[other.action])) {
        return null
      }
    }
  }

  return bindings
}

function normalizeCompleteBindings(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  return normalizeBindingRecord(value, HOTKEY_COMMANDS)
}

function migrateLegacyBindings(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  return normalizeBindingRecord(value, ANNOTATION_COMMANDS)
}

export function parseStoredHotkeyPreferences(serialized: string): StoredHotkeyPreferences | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  }
  catch {
    return null
  }

  if (!isRecord(parsed)) return null
  if (parsed.version === HOTKEY_PREFERENCES_VERSION) {
    const bindings = normalizeCompleteBindings(parsed.bindings)
    return bindings ? { version: HOTKEY_PREFERENCES_VERSION, bindings } : null
  }

  const legacySource = parsed.version === 2 && isRecord(parsed.bindings)
    ? parsed.bindings
    : parsed
  const bindings = migrateLegacyBindings(legacySource)
  return bindings ? { version: HOTKEY_PREFERENCES_VERSION, bindings } : null
}

export function serializeHotkeyPreferences(bindings: HotkeyBindings): string {
  return JSON.stringify({ version: HOTKEY_PREFERENCES_VERSION, bindings })
}
