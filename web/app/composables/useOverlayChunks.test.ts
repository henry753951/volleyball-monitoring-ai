import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOverlayChunks } from './useOverlayChunks'

afterEach(() => vi.unstubAllGlobals())

describe('useOverlayChunks power state', () => {
  it('does not request or decode overlay data while disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const enabled = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        useOverlayChunks(() => 'analysis', () => 0, enabled)
        return () => h('div')
      },
    }))

    await nextTick()
    expect(fetchMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('aborts an in-flight manifest request when the overlay is switched off', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }))
    const enabled = ref(true)
    const wrapper = mount(defineComponent({
      setup() {
        useOverlayChunks(() => 'analysis', () => 0, enabled)
        return () => h('div')
      },
    }))

    await nextTick()
    expect(signal?.aborted).toBe(false)
    enabled.value = false
    await nextTick()
    expect(signal?.aborted).toBe(true)
    wrapper.unmount()
  })
})
