import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ClipDownloadDialog from './ClipDownloadDialog.vue'

const global = {
  renderStubDefaultSlot: true,
  stubs: {
    UiAnimatedModal: { template: '<section><slot /><slot name="footer" /></section>' },
    UiButton: { template: '<button :disabled="$attrs.disabled"><slot /></button>' },
    DialogDescription: { template: '<p><slot /></p>' },
  },
}

describe('ClipDownloadDialog', () => {
  it('keeps dataset export unavailable until an analysis exists', () => {
    const wrapper = mount(ClipDownloadDialog, {
      props: { open: true, rallyId: 'rally-1', analysisRunId: null, title: 'Test case' },
      global,
    })
    expect(wrapper.get('input[value="dataset"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('此片段尚未完成 AI 分析')
  })

  it('downloads the server-streamed dataset ZIP for the selected analysis', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const append = vi.spyOn(document.body, 'append')
    const wrapper = mount(ClipDownloadDialog, {
      props: { open: true, rallyId: 'rally-1', analysisRunId: 'analysis-1', title: 'Test case' },
      global,
    })
    await wrapper.get('input[value="dataset"]').setValue(true)
    await wrapper.findAll('button').at(-1)!.trigger('click')
    const anchor = append.mock.calls.at(-1)?.[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('/api/v1/analysis-runs/analysis-1/dataset.zip')
    expect(click).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toHaveLength(1)
    click.mockRestore()
    append.mockRestore()
  })
})
