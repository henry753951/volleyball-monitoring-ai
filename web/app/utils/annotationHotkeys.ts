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

export type MediaAction = 'play_pause' | 'frame_previous' | 'frame_next'
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
  { action: 'service', group: 'annotation', label: '發球', description: '開始新的回合並記錄發球時刻' },
  { action: 'contact', group: 'annotation', label: '擊球', description: '記錄目前畫面的擊球時刻' },
  {
    action: 'close_left',
    group: 'annotation',
    label: '左側得分',
    description: '以最後一個擊球點結束回合並記錄左側得分',
  },
  {
    action: 'close_right',
    group: 'annotation',
    label: '右側得分',
    description: '以最後一個擊球點結束回合並記錄右側得分',
  },
  {
    action: 'close_unknown',
    group: 'annotation',
    label: '未知',
    description: '以最後一個擊球點結束回合，結果保留為未知',
  },
  { action: 'submit', group: 'annotation', label: '送出', description: '送出目前回合進行分析' },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const MEDIA_COMMANDS = [
  { action: 'play_pause', group: 'media', label: '播放／暫停', description: '切換目前影片的播放狀態' },
  { action: 'frame_previous', group: 'media', label: '上一幀', description: '由伺服器解析並移到上一個權威畫格' },
  { action: 'frame_next', group: 'media', label: '下一幀', description: '由伺服器解析並移到下一個權威畫格' },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const HOTKEY_COMMANDS: ReadonlyArray<HotkeyCommandDefinition> = [
  ...ANNOTATION_COMMANDS,
  ...MEDIA_COMMANDS,
]

export const HOTKEY_PREFERENCES_VERSION = 4 as const
export const HOTKEY_PREFERENCES_STORAGE_KEY = 'volleyball-monitoring-ai:hotkeys:4'
export const LEGACY_ANNOTATION_HOTKEYS_STORAGE_KEY = 'volleyball-monitoring-ai:annotation-hotkeys:2'

export const DEFAULT_HOTKEY_BINDINGS: Readonly<HotkeyBindings> = Object.freeze({
  service: 'Z',
  contact: 'X',
  close_left: '<',
  close_right: '>',
  close_unknown: '?',
  submit: 'Enter',
  play_pause: 'Space',
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

function migrateVersionThree(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  const source = isRecord(value.bindings) ? value.bindings : value
  const bindings = restoreDefaultHotkeys()
  for (const command of HOTKEY_COMMANDS) {
    if (command.action === 'play_pause') continue
    const raw = source[command.action]
    if (typeof raw !== 'string') return null
    const normalized = normalizeRecordedHotkey(raw)
    if (!normalized || isBrowserReservedHotkey(normalized)) return null
    bindings[command.action] = command.action === 'contact' && normalized === 'Space' ? 'X' : normalized
  }
  return normalizeBindingRecord(bindings, HOTKEY_COMMANDS)
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

  if (parsed.version === 3) {
    const bindings = migrateVersionThree(parsed)
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
