import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VolleyballOverlayCanvas from './VolleyballOverlayCanvas.vue'

describe('VolleyballOverlayCanvas presentation timing', () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  const clearRect = vi.fn()
  const originalResizeObserver = globalThis.ResizeObserver
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  let nextFrameId = 0

  beforeEach(() => {
    callbacks.clear()
    nextFrameId = 0
    clearRect.mockClear()
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      callbacks.set(id, callback)
      return id
    })
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      callbacks.delete(id)
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect,
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.ResizeObserver = originalResizeObserver
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  })

  it('draws a newly presented video frame without queueing a second animation frame', async () => {
    const wrapper = mount(VolleyballOverlayCanvas, {
      props: {
        events: [],
        frame: 0,
        videoWidth: 1920,
        videoHeight: 1080,
        layers: {
          bbox: false,
          trackId: false,
          action: false,
          ball: false,
          trail: false,
          footprint: false,
          confidence: false,
          court: false,
          nextHit: false,
        },
      },
    })
    vi.spyOn(wrapper.get('canvas').element, 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 360,
    } as DOMRect)

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    callbacks.get(1)?.(0)
    expect(clearRect).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ frame: 1 })

    expect(clearRect).toHaveBeenCalledTimes(2)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })
})
