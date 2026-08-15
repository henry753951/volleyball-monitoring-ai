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
  'service' | 'contact' | 'close_left' | 'close_right' | 'close_unknown' | 'submit'

export type MediaAction =
  'play_pause' | 'frame_previous' | 'frame_next' | 'key_point_previous' | 'key_point_next'
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
  {
    action: 'service',
    group: 'annotation',
    label: '片段開始 / 結束',
    description: '第一次按 Z 設定片段開始；再次按 Z 設定片段結束。Z 不代表發球或落點。',
  },
  { action: 'contact', group: 'annotation', label: '擊球', description: '記錄目前畫面的擊球時刻' },
  {
    action: 'close_left',
    group: 'annotation',
    label: '左側得分',
    description: '將目前片段結果記錄為左側得分；不會結束片段',
  },
  {
    action: 'close_right',
    group: 'annotation',
    label: '右側得分',
    description: '將目前片段結果記錄為右側得分；不會結束片段',
  },
  {
    action: 'close_unknown',
    group: 'annotation',
    label: '未知',
    description: '將目前片段結果標記為未知；不會結束片段',
  },
  { action: 'submit', group: 'annotation', label: '送出', description: '送出目前回合進行分析' },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const MEDIA_COMMANDS = [
  {
    action: 'play_pause',
    group: 'media',
    label: '播放／暫停',
    description: '切換目前影片的播放狀態',
  },
  {
    action: 'frame_previous',
    group: 'media',
    label: '上一幀',
    description: '由伺服器解析並移到上一個權威畫格',
  },
  {
    action: 'frame_next',
    group: 'media',
    label: '下一幀',
    description: '由伺服器解析並移到下一個權威畫格',
  },
  {
    action: 'key_point_previous',
    group: 'media',
    label: '上一個擊球點',
    description: '跨片段移到時間軸上的上一個擊球點',
  },
  {
    action: 'key_point_next',
    group: 'media',
    label: '下一個擊球點',
    description: '跨片段移到時間軸上的下一個擊球點',
  },
] as const satisfies ReadonlyArray<HotkeyCommandDefinition>

export const HOTKEY_COMMANDS: ReadonlyArray<HotkeyCommandDefinition> = [
  ...ANNOTATION_COMMANDS,
  ...MEDIA_COMMANDS,
]

export const HOTKEY_PREFERENCES_VERSION = 5 as const
export const HOTKEY_PREFERENCES_STORAGE_KEY = 'volleyball-monitoring-ai:hotkeys:5'
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
  key_point_previous: 'A',
  key_point_next: 'D',
})

const PRODUCT_PUNCTUATION_BASE_KEYS = {
  '<': ',',
  '>': '.',
  '?': '/',
} as const

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
  | { ok: true; bindings: HotkeyBindings }
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

/** Resolve product punctuation labels to their unshifted physical keys. */
export function toRuntimeHotkey(binding: string): RegisterableHotkey {
  const baseKey =
    PRODUCT_PUNCTUATION_BASE_KEYS[binding as keyof typeof PRODUCT_PUNCTUATION_BASE_KEYS]
  if (baseKey) return baseKey as Hotkey
  return binding as Hotkey
}

/**
 * Product punctuation works from the base key without Shift. Keep the shifted
 * character as a backwards-compatible alias for operators who already use it.
 */
export function runtimeHotkeysForBinding(binding: string): ReadonlyArray<RegisterableHotkey> {
  const runtime = toRuntimeHotkey(binding)
  if (!(binding in PRODUCT_PUNCTUATION_BASE_KEYS)) return [runtime]
  return [runtime, { key: binding, shift: true }]
}

export function formatBindingForDisplay(
  binding: string,
  options: FormatDisplayOptions = {},
): string {
  return formatForDisplay(binding, options)
}

function bindingMatchesOnEitherPlatform(left: string, right: string): boolean {
  return (['mac', 'windows'] as const).some(
    platform =>
      normalizeRuntimeBinding(left, platform) === normalizeRuntimeBinding(right, platform),
  )
}

function normalizeRuntimeBinding(binding: string, platform: 'mac' | 'windows' | 'linux'): string {
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
  return BROWSER_RESERVED_HOTKEYS.some(reserved =>
    bindingMatchesOnEitherPlatform(binding, reserved),
  )
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

  const conflict = HOTKEY_COMMANDS.find(
    command =>
      command.action !== action &&
      bindingMatchesOnEitherPlatform(bindings[command.action], nextBinding),
  )
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

export function commandForBinding(binding: string, bindings: HotkeyBindings): HotkeyCommand | null {
  return (
    HOTKEY_COMMANDS.find(command =>
      bindingMatchesOnEitherPlatform(bindings[command.action], binding),
    )?.action ?? null
  )
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

  for (const [index, command] of commands.entries()) {
    for (const other of commands.slice(index + 1)) {
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

function assignMigrationNavigationDefaults(bindings: HotkeyBindings) {
  const candidates: Record<'key_point_previous' | 'key_point_next', string[]> = {
    key_point_previous: ['A', 'PageUp', 'J'],
    key_point_next: ['D', 'PageDown', 'K'],
  }
  for (const action of ['key_point_previous', 'key_point_next'] as const) {
    const candidate = candidates[action].find(binding =>
      HOTKEY_COMMANDS.every(
        command =>
          command.action === action ||
          !bindingMatchesOnEitherPlatform(bindings[command.action], binding),
      ),
    )
    if (!candidate) return false
    bindings[action] = candidate
  }
  return true
}

function migrateLegacyBindings(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  const bindings = normalizeBindingRecord(value, ANNOTATION_COMMANDS)
  if (!bindings || !assignMigrationNavigationDefaults(bindings)) return null
  return normalizeBindingRecord(bindings, HOTKEY_COMMANDS)
}

function migrateVersionThree(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  const source = isRecord(value.bindings) ? value.bindings : value
  const bindings = restoreDefaultHotkeys()
  for (const command of HOTKEY_COMMANDS) {
    if (
      command.action === 'play_pause' ||
      command.action === 'key_point_previous' ||
      command.action === 'key_point_next'
    )
      continue
    const raw = source[command.action]
    if (typeof raw !== 'string') return null
    const normalized = normalizeRecordedHotkey(raw)
    if (!normalized || isBrowserReservedHotkey(normalized)) return null
    bindings[command.action] =
      command.action === 'contact' && normalized === 'Space' ? 'X' : normalized
  }
  if (!assignMigrationNavigationDefaults(bindings)) return null
  return normalizeBindingRecord(bindings, HOTKEY_COMMANDS)
}

function migrateVersionFour(value: unknown): HotkeyBindings | null {
  if (!isRecord(value)) return null
  const source = isRecord(value.bindings) ? value.bindings : value
  const bindings = restoreDefaultHotkeys()
  for (const command of HOTKEY_COMMANDS) {
    if (command.action === 'key_point_previous' || command.action === 'key_point_next') continue
    const raw = source[command.action]
    if (typeof raw !== 'string') return null
    const normalized = normalizeRecordedHotkey(raw)
    if (!normalized || isBrowserReservedHotkey(normalized)) return null
    bindings[command.action] = normalized
  }
  if (!assignMigrationNavigationDefaults(bindings)) return null
  return normalizeBindingRecord(bindings, HOTKEY_COMMANDS)
}

export function parseStoredHotkeyPreferences(serialized: string): StoredHotkeyPreferences | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
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

  if (parsed.version === 4) {
    const bindings = migrateVersionFour(parsed)
    return bindings ? { version: HOTKEY_PREFERENCES_VERSION, bindings } : null
  }

  const legacySource = parsed.version === 2 && isRecord(parsed.bindings) ? parsed.bindings : parsed
  const bindings = migrateLegacyBindings(legacySource)
  return bindings ? { version: HOTKEY_PREFERENCES_VERSION, bindings } : null
}

export function serializeHotkeyPreferences(bindings: HotkeyBindings): string {
  return JSON.stringify({ version: HOTKEY_PREFERENCES_VERSION, bindings })
}
