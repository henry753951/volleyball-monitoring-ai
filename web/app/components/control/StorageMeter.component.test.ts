import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StorageMeter from './StorageMeter.vue'

describe('StorageMeter', () => {
  it('shows total and available capacity without presenting free space as total capacity', () => {
    const wrapper = mount(StorageMeter, {
      props: {
        detail: 'MinIO · http://127.0.0.1:9000',
        kind: 'object',
        label: 'S3 物件儲存',
        storage: {
          available: true,
          freeBytes: '824633720832',
          managedBytes: '274877906944',
          path: 'http://127.0.0.1:9000',
          totalBytes: '1099511627776',
          usedBytes: '274877906944',
        },
      },
    })

    expect(wrapper.text()).toContain('S3 物件儲存')
    expect(wrapper.text()).toContain('768.0 GiB 可用')
    expect(wrapper.text()).toContain('256.0 GiB 已使用 · 25.0%')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25')
  })

  it('uses an explicit unavailable state when the capacity endpoint cannot be reached', () => {
    const wrapper = mount(StorageMeter, {
      props: {
        detail: '',
        kind: 'temporary',
        label: 'Server 暫存空間',
        storage: null,
      },
    })

    expect(wrapper.text()).toContain('容量監控目前無法連線')
    expect(wrapper.text()).toContain('狀態未知')
  })
})
