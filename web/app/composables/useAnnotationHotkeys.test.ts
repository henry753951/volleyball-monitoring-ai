import { getHotkeyManager, useHotkeyRecorder, useHotkeys } from '@tanstack/vue-hotkeys'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import { normalizeRecordedHotkey, restoreDefaultHotkeys } from '../utils/annotationHotkeys'
import { createAnnotationHotkeyDefinitions } from './useAnnotationHotkeys'
import type { HotkeyBindings, HotkeyCommand } from '../utils/annotationHotkeys'

class FakeNode extends EventTarget {
  children: FakeNode[] = []
  parentNode: FakeNode | null = null
  nodeType = 1

  contains(candidate: EventTarget | null): boolean {
    if (candidate === this) return true
    return this.children.some((child) => child.contains(candidate))
  }
}

class FakeElement extends FakeNode {
  isContentEditable = false
  ownerDocument: FakeDocument
  tagName: string

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super()
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
  }
}

class FakeInputElement extends FakeElement {
  type = 'text'
}

class FakeTextAreaElement extends FakeElement {}
class FakeSelectElement extends FakeElement {}

class FakeDocument extends FakeNode {
  activeElement: FakeElement | null = null
  documentElement: FakeElement
  modalOpen = false

  constructor() {
    super()
    this.nodeType = 9
    this.documentElement = new FakeElement('html', this)
  }

  querySelector(): FakeElement | null {
    return this.modalOpen ? new FakeElement('dialog', this) : null
  }
}

class FakeKeyboardEvent extends Event {
  altKey = false
  code: string
  ctrlKey = false
  isComposing = false
  key: string
  metaKey = false
  repeat = false
  shiftKey = false

  constructor(
    key: string,
    code: string,
    modifiers: Partial<Pick<FakeKeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
    eventType = 'keydown',
  ) {
    super(eventType, { bubbles: true, cancelable: true })
    this.key = key
    this.code = code
    Object.assign(this, modifiers)
  }

  override composedPath(): EventTarget[] {
    return [this.target].filter((target): target is EventTarget => Boolean(target))
  }
}

function createFakeRenderer(document: FakeDocument) {
  return createRenderer<FakeNode, FakeElement>({
    createComment: () => new FakeNode(),
    createElement: (tag) => tag === 'input'
      ? new FakeInputElement(tag, document)
      : new FakeElement(tag, document),
    createText: () => new FakeNode(),
    insert: (child, parent, anchor) => {
      child.parentNode = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index >= 0) parent.children.splice(index, 0, child)
      else parent.children.push(child)
    },
    nextSibling: (node) => {
      if (!node.parentNode) return null
      const index = node.parentNode.children.indexOf(node)
      return node.parentNode.children[index + 1] ?? null
    },
    parentNode: (node) => node.parentNode as FakeElement | null,
    patchProp: () => {},
    remove: (child) => {
      if (!child.parentNode) return
      child.parentNode.children = child.parentNode.children.filter((node) => node !== child)
      child.parentNode = null
    },
    setElementText: () => {},
    setText: () => {},
  })
}

function keydown(target: FakeElement, key: string, code: string) {
  const event = new FakeKeyboardEvent(key, code)
  target.dispatchEvent(event)
  return event
}

function keyup(target: FakeElement, key: string, code: string) {
  target.dispatchEvent(new FakeKeyboardEvent(key, code, {}, 'keyup'))
}

describe('annotation TanStack runtime adapter', () => {
  let document: FakeDocument

  beforeEach(() => {
    document = new FakeDocument()
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('HTMLElement', FakeElement)
    vi.stubGlobal('HTMLInputElement', FakeInputElement)
    vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement)
    vi.stubGlobal('HTMLSelectElement', FakeSelectElement)
    vi.stubGlobal('document', document)
    vi.stubGlobal('window', { document })
    getHotkeyManager().destroy()
  })

  afterEach(() => {
    getHotkeyManager().destroy()
    vi.unstubAllGlobals()
  })

  it('reactively remaps within its scope, ignores inputs, and cleans up on unmount', async () => {
    const bindings = ref<HotkeyBindings>(restoreDefaultHotkeys())
    const scopeEnabled = ref(true)
    const calls: HotkeyCommand[] = []
    const renderer = createFakeRenderer(document)
    const root = new FakeElement('root', document)

    const app = renderer.createApp(defineComponent({
      setup() {
        const scope = ref<HTMLElement | null>(null)
        useHotkeys(
          () => createAnnotationHotkeyDefinitions(
            bindings.value,
            (command) => calls.push(command),
            undefined,
            undefined,
            () => scopeEnabled.value,
          ),
          {
            target: scope,
            conflictBehavior: 'error',
            ignoreInputs: true,
            preventDefault: false,
            requireReset: true,
            stopPropagation: false,
          },
        )
        return () => h('section', { ref: scope })
      },
    }))

    app.mount(root)
    await nextTick()
    const scope = root.children[0] as FakeElement
    expect(getHotkeyManager().getRegistrationCount()).toBe(13)

    expect(keydown(scope, 'z', 'KeyZ').defaultPrevented).toBe(true)
    expect(calls).toEqual(['service'])
    keyup(scope, 'z', 'KeyZ')

    bindings.value = { ...bindings.value, service: 'S' }
    await nextTick()
    expect(getHotkeyManager().getRegistrationCount()).toBe(13)
    keydown(scope, 'z', 'KeyZ')
    keydown(scope, 's', 'KeyS')
    expect(calls).toEqual(['service', 'service'])
    keyup(scope, 's', 'KeyS')

    const editable = new FakeElement('div', document)
    editable.isContentEditable = true
    for (const focused of [
      new FakeInputElement('input', document),
      new FakeTextAreaElement('textarea', document),
      new FakeSelectElement('select', document),
      editable,
    ]) {
      document.activeElement = focused
      keydown(scope, 's', 'KeyS')
      expect(calls).toHaveLength(2)
      keyup(scope, 's', 'KeyS')
    }
    document.activeElement = null

    const outside = new FakeElement('aside', document)
    keydown(outside, 's', 'KeyS')
    expect(calls).toHaveLength(2)

    document.modalOpen = true
    expect(keydown(scope, 's', 'KeyS').defaultPrevented).toBe(false)
    expect(calls).toHaveLength(2)
    keyup(scope, 's', 'KeyS')
    document.modalOpen = false

    scopeEnabled.value = false
    await nextTick()
    keydown(scope, 's', 'KeyS')
    expect(calls).toHaveLength(2)

    app.unmount()
    expect(getHotkeyManager().getRegistrationCount()).toBe(0)
    keydown(scope, 's', 'KeyS')
    expect(calls).toHaveLength(2)
  })

  it('records and normalizes a shifted product key, then removes its listener on unmount', async () => {
    const recorded: string[] = []
    let startRecording: (() => void) | undefined
    const renderer = createFakeRenderer(document)
    const root = new FakeElement('root', document)

    const app = renderer.createApp(defineComponent({
      setup() {
        const recorder = useHotkeyRecorder({
          onRecord: (hotkey) => {
            const normalized = normalizeRecordedHotkey(hotkey, 'windows')
            if (normalized) recorded.push(normalized)
          },
        })
        startRecording = recorder.startRecording
        return () => h('section')
      },
    }))

    app.mount(root)
    await nextTick()
    startRecording?.()
    document.dispatchEvent(new FakeKeyboardEvent('<', 'Comma', { shiftKey: true }))
    expect(recorded).toEqual(['<'])

    startRecording?.()
    app.unmount()
    document.dispatchEvent(new FakeKeyboardEvent('s', 'KeyS'))
    expect(recorded).toEqual(['<'])
  })
})
