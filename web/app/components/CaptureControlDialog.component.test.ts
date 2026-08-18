import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref, shallowRef, watch, type Component } from 'vue'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('~/lib/coreDomain', () => ({
  createCoreDomainClient: () => ({ stopCapture: vi.fn() }),
  createGraphQLTransport: vi.fn(),
}))
vi.mock('~/lib/mediaSourceClient', () => ({
  createMediaSourceClient: () => ({ create: mocks.create }),
}))
vi.mock('vue-sonner', () => ({
  toast: { error: vi.fn(), success: mocks.toastSuccess },
}))

let CaptureControlDialog: Component

beforeAll(async () => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('shallowRef', shallowRef)
  vi.stubGlobal('watch', watch)
  CaptureControlDialog = (await import('./CaptureControlDialog.vue')).default
})

describe('CaptureControlDialog', () => {
  it('closes after a media source is created successfully', async () => {
    mocks.create.mockResolvedValueOnce({ capture_session_id: 'capture-1' })
    const wrapper = mount(CaptureControlDialog, {
      props: { captures: [], matchId: 'match-1', open: true },
      global: {
        stubs: {
          ConfirmActionDialog: true,
          MediaSourcePicker: {
            emits: ['update:modelValue'],
            template:
              "<button data-test=\"source\" @click=\"$emit('update:modelValue', { kind: 'youtube', label: '', url: 'https://www.youtube.com/watch?v=test' })\">source</button>",
          },
          UiAnimatedModal: {
            props: ['open'],
            template: '<section v-if="open"><slot /><slot name="footer" /></section>',
          },
          UiButton: {
            template: '<button :disabled="$attrs.disabled"><slot /></button>',
          },
          UiScrollArea: { template: '<div><slot /></div>' },
        },
      },
    })

    await wrapper.get('[data-test="source"]').trigger('click')
    await wrapper
      .findAll('button')
      .find(button => button.text().includes('加入影音來源'))!
      .trigger('click')
    await flushPromises()

    expect(mocks.create).toHaveBeenCalledWith('match-1', {
      kind: 'youtube',
      label: '',
      url: 'https://www.youtube.com/watch?v=test',
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('影音來源已加入')
  })
})
