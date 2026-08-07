import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_COMMANDS,
  commandForBinding,
  DEFAULT_HOTKEY_BINDINGS,
  formatBindingForDisplay,
  HOTKEY_COMMANDS,
  HOTKEY_PREFERENCES_VERSION,
  MEDIA_COMMANDS,
  normalizeRecordedHotkey,
  parseStoredHotkeyPreferences,
  rebindHotkey,
  restoreDefaultHotkeys,
  serializeHotkeyPreferences,
  toRuntimeHotkey,
} from './annotationHotkeys'

describe('annotation hotkey registry', () => {
  it('defines all annotation and media defaults without a standalone end-rally key', () => {
    expect(ANNOTATION_COMMANDS.map(({ action }) => action)).toEqual([
      'service',
      'contact',
      'close_left',
      'close_right',
      'close_unknown',
      'submit',
    ])
    expect(MEDIA_COMMANDS.map(({ action }) => action)).toEqual([
      'frame_previous',
      'frame_next',
    ])
    expect(DEFAULT_HOTKEY_BINDINGS).toEqual({
      service: 'Z',
      contact: 'Space',
      close_left: '<',
      close_right: '>',
      close_unknown: '?',
      submit: 'Enter',
      frame_previous: 'ArrowLeft',
      frame_next: 'ArrowRight',
    })
    expect(Object.values(DEFAULT_HOTKEY_BINDINGS)).not.toContain('X')
  })

  it('remaps one command and disables the previous physical binding', () => {
    const defaults = restoreDefaultHotkeys()
    const rebound = rebindHotkey(defaults, 'service', 's')
    expect(rebound.ok).toBe(true)
    if (!rebound.ok) return

    expect(commandForBinding('S', rebound.bindings)).toBe('service')
    expect(commandForBinding('Z', rebound.bindings)).toBeNull()
  })

  it('restores all eight defaults atomically, including media arrows', () => {
    const edited = { ...restoreDefaultHotkeys(), service: 'S', frame_previous: 'J' }
    expect(edited).not.toEqual(DEFAULT_HOTKEY_BINDINGS)
    expect(restoreDefaultHotkeys()).toEqual(DEFAULT_HOTKEY_BINDINGS)
    expect(Object.keys(restoreDefaultHotkeys())).toEqual(HOTKEY_COMMANDS.map(({ action }) => action))
  })

  it('normalizes recorder output while preserving product punctuation defaults', () => {
    expect(normalizeRecordedHotkey('shift+<', 'windows')).toBe('<')
    expect(normalizeRecordedHotkey('shift+>', 'windows')).toBe('>')
    expect(normalizeRecordedHotkey('shift+?', 'windows')).toBe('?')
    expect(normalizeRecordedHotkey('ctrl+shift+s', 'windows')).toBe('Mod+Shift+S')
    expect(normalizeRecordedHotkey('Shift')).toBeNull()
    expect(toRuntimeHotkey('<')).toEqual({ key: '<', shift: true })
  })

  it('uses TanStack platform display formatting for every adapter badge', () => {
    expect(formatBindingForDisplay('Mod+Shift+S', { platform: 'mac' })).toBe('⌘ ⇧ S')
    expect(formatBindingForDisplay('Mod+Shift+S', { platform: 'windows' })).toBe('Ctrl+Shift+S')
    expect(formatBindingForDisplay('ArrowLeft', { platform: 'mac' })).toBe('←')
    expect(formatBindingForDisplay('Space', { platform: 'windows' })).toBe('␣')
  })

  it('rejects conflicts, browser-reserved gestures and invalid recordings without mutation', () => {
    const defaults = restoreDefaultHotkeys()
    expect(rebindHotkey(defaults, 'service', 'Space')).toMatchObject({
      ok: false,
      reason: 'conflict',
      conflictWith: 'contact',
      bindings: defaults,
    })
    expect(rebindHotkey(defaults, 'service', 'Control+L')).toMatchObject({
      ok: false,
      reason: 'reserved',
      bindings: defaults,
    })
    expect(rebindHotkey(defaults, 'service', '')).toMatchObject({
      ok: false,
      reason: 'invalid',
      bindings: defaults,
    })
    expect(defaults).toEqual(DEFAULT_HOTKEY_BINDINGS)
  })
})

describe('hotkey preference persistence', () => {
  it('round-trips the versioned v3 envelope', () => {
    const bindings = { ...restoreDefaultHotkeys(), service: 'S' }
    expect(parseStoredHotkeyPreferences(serializeHotkeyPreferences(bindings))).toEqual({
      version: HOTKEY_PREFERENCES_VERSION,
      bindings,
    })
  })

  it('migrates a legacy v2 annotation-only record and supplies media defaults', () => {
    const legacy = {
      service: 'A',
      contact: 'B',
      close_left: 'C',
      close_right: 'D',
      close_unknown: 'E',
      submit: 'F',
    }
    expect(parseStoredHotkeyPreferences(JSON.stringify(legacy))).toEqual({
      version: HOTKEY_PREFERENCES_VERSION,
      bindings: {
        ...legacy,
        frame_previous: 'ArrowLeft',
        frame_next: 'ArrowRight',
      },
    })
    expect(parseStoredHotkeyPreferences(JSON.stringify({ version: 2, bindings: legacy })))
      .toEqual(parseStoredHotkeyPreferences(JSON.stringify(legacy)))
  })

  it('accepts swapped bindings and rejects corrupt, duplicate or reserved stored records', () => {
    const swapped = { ...restoreDefaultHotkeys(), service: 'Space', contact: 'Z' }
    expect(parseStoredHotkeyPreferences(serializeHotkeyPreferences(swapped))?.bindings).toEqual(swapped)

    const duplicate = { ...restoreDefaultHotkeys(), service: 'Space' }
    const reserved = { ...restoreDefaultHotkeys(), service: 'Mod+L' }
    expect(parseStoredHotkeyPreferences(serializeHotkeyPreferences(duplicate))).toBeNull()
    expect(parseStoredHotkeyPreferences(serializeHotkeyPreferences(reserved))).toBeNull()
    expect(parseStoredHotkeyPreferences('{not-json')).toBeNull()
  })
})
