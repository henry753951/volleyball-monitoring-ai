import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnalysisFrameChunks } from './useAnalysisFrameChunks'

afterEach(() => vi.unstubAllGlobals())

describe('useAnalysisFrameChunks power state', () => {
  it('does not request or decode AnalysisData while disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const enabled = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        useAnalysisFrameChunks(() => 'analysis', () => 0, enabled)
        return () => h('div')
      },
    }))

    await nextTick()
    expect(fetchMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('aborts an in-flight manifest request when AnalysisData display is switched off', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }))
    const enabled = ref(true)
    const wrapper = mount(defineComponent({
      setup() {
        useAnalysisFrameChunks(() => 'analysis', () => 0, enabled)
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
