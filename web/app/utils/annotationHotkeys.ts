export type AnnotationAction =
  | 'service'
  | 'contact'
  | 'close_left'
  | 'close_right'
  | 'close_unknown'
  | 'submit'

export type AnnotationHotkeyBindings = Record<AnnotationAction, string>

export const ANNOTATION_COMMANDS = [
  { action: 'service', label: '發球' },
  { action: 'contact', label: '擊球' },
  { action: 'close_left', label: '左側得分' },
  { action: 'close_right', label: '右側得分' },
  { action: 'close_unknown', label: '未知' },
  { action: 'submit', label: '提交' },
] as const satisfies ReadonlyArray<{ action: AnnotationAction, label: string }>

export const DEFAULT_ANNOTATION_HOTKEYS: Readonly<AnnotationHotkeyBindings> = Object.freeze({
  service: 'Z',
  contact: 'Space',
  close_left: '<',
  close_right: '>',
  close_unknown: '?',
  submit: 'Enter',
})

export function restoreDefaultAnnotationHotkeys(): AnnotationHotkeyBindings {
  return { ...DEFAULT_ANNOTATION_HOTKEYS }
}

type KeyboardBindingEvent = Pick<KeyboardEvent, 'code' | 'key'> &
  Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>>

export function normalizeAnnotationKey(event: KeyboardBindingEvent): string | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.code === 'Space') return 'Space'
  if (event.key === 'Enter') return 'Enter'
  if (event.key === '<' || event.key === '>' || event.key === '?') return event.key
  if (event.key.length === 1 && /[a-z0-9]/i.test(event.key)) return event.key.toUpperCase()
  return null
}

export function actionForAnnotationKey(
  event: KeyboardBindingEvent,
  bindings: AnnotationHotkeyBindings,
): AnnotationAction | null {
  const normalized = normalizeAnnotationKey(event)
  if (!normalized) return null
  return ANNOTATION_COMMANDS.find(({ action }) => bindings[action] === normalized)?.action ?? null
}

export type RebindResult =
  | { ok: true, bindings: AnnotationHotkeyBindings }
  | { ok: false, conflictWith: AnnotationAction, bindings: AnnotationHotkeyBindings }

export function rebindAnnotationHotkey(
  bindings: AnnotationHotkeyBindings,
  action: AnnotationAction,
  nextBinding: string,
): RebindResult {
  const conflict = ANNOTATION_COMMANDS.find((command) =>
    command.action !== action && bindings[command.action] === nextBinding)
  if (conflict) return { ok: false, conflictWith: conflict.action, bindings }
  return { ok: true, bindings: { ...bindings, [action]: nextBinding } }
}
