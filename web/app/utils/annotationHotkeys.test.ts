import { describe, expect, it } from 'vitest'
import {
  actionForAnnotationKey,
  ANNOTATION_COMMANDS,
  DEFAULT_ANNOTATION_HOTKEYS,
  rebindAnnotationHotkey,
  restoreDefaultAnnotationHotkeys,
} from './annotationHotkeys'

describe('annotation hotkey registry', () => {
  it('defines the six v2 defaults without a standalone end-rally key', () => {
    expect(ANNOTATION_COMMANDS.map(({ action }) => action)).toEqual([
      'service',
      'contact',
      'close_left',
      'close_right',
      'close_unknown',
      'submit',
    ])
    expect(DEFAULT_ANNOTATION_HOTKEYS).toEqual({
      service: 'Z',
      contact: 'Space',
      close_left: '<',
      close_right: '>',
      close_unknown: '?',
      submit: 'Enter',
    })
    expect(Object.values(DEFAULT_ANNOTATION_HOTKEYS)).not.toContain('X')
  })

  it('routes touch-equivalent physical bindings through the command registry', () => {
    const bindings = restoreDefaultAnnotationHotkeys()
    expect(actionForAnnotationKey({ code: 'KeyZ', key: 'z' }, bindings)).toBe('service')
    expect(actionForAnnotationKey({ code: 'Comma', key: '<' }, bindings)).toBe('close_left')
    expect(actionForAnnotationKey({ code: 'Slash', key: '?' }, bindings)).toBe('close_unknown')
    expect(actionForAnnotationKey({ code: 'KeyR', key: 'r', ctrlKey: true }, bindings)).toBeNull()
  })

  it('rejects conflicts and Restore Defaults returns all six original bindings', () => {
    const defaults = restoreDefaultAnnotationHotkeys()
    expect(rebindAnnotationHotkey(defaults, 'service', 'Space')).toEqual({
      ok: false,
      conflictWith: 'contact',
      bindings: defaults,
    })
    const rebound = rebindAnnotationHotkey(defaults, 'service', 'S')
    expect(rebound.ok).toBe(true)
    expect(restoreDefaultAnnotationHotkeys()).toEqual(DEFAULT_ANNOTATION_HOTKEYS)
  })
})
