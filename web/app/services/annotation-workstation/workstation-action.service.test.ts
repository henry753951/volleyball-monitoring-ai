import { computed, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createWorkstationActionManager } from './workstation-action.service'
import { createWorkstationFeedbackService } from './workstation-feedback.service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createWorkstationActionManager', () => {
  it('uses one reactive availability decision for UI and execution', async () => {
    const allowed = ref(false)
    const execute = vi.fn()
    const manager = createWorkstationActionManager()
    manager.register({
      id: 'mark.contact',
      group: 'marking',
      label: '擊球',
      availability: computed(() => ({
        enabled: allowed.value,
        reason: allowed.value ? null : '片段尚未開始',
      })),
      execute,
    })

    expect(manager.state('mark.contact').value.enabled).toBe(false)
    expect(await manager.execute('mark.contact')).toEqual({
      status: 'blocked',
      reason: '片段尚未開始',
    })
    expect(execute).not.toHaveBeenCalled()

    allowed.value = true
    await nextTick()
    expect(manager.state('mark.contact').value.enabled).toBe(true)
    expect(await manager.execute('mark.contact')).toEqual({ status: 'executed', value: undefined })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('locks related resources while an async action is running', async () => {
    const request = deferred<void>()
    const manager = createWorkstationActionManager()
    manager.register({
      id: 'submission.submit',
      group: 'submission',
      label: '送出',
      resources: ['annotation-draft'],
      execute: () => request.promise,
    })
    manager.register({
      id: 'mark.contact',
      group: 'marking',
      label: '擊球',
      resources: ['annotation-draft'],
      execute: vi.fn(),
    })

    const submission = manager.execute('submission.submit')
    await nextTick()
    expect(manager.state('mark.contact').value.pending).toBe(true)
    expect((await manager.execute('mark.contact')).status).toBe('blocked')

    request.resolve()
    await submission
    expect(manager.state('mark.contact').value.enabled).toBe(true)
  })

  it('reports blocked and failed actions through one feedback channel', async () => {
    const feedback = createWorkstationFeedbackService()
    const manager = createWorkstationActionManager({ feedback })
    manager.register({
      id: 'sync.resync',
      group: 'sync',
      label: '重新同步',
      availability: { enabled: false, reason: '尚未連線' },
      execute: vi.fn(),
    })
    manager.register({
      id: 'analysis.apply',
      group: 'analysis',
      label: '套用修改',
      execute: () => {
        throw new Error('同步失敗')
      },
    })

    await manager.execute('sync.resync')
    await manager.execute('analysis.apply')

    expect(feedback.messages.value.map(message => message.level)).toEqual(['warning', 'error'])
    expect(feedback.messages.value.at(-1)?.description).toBe('同步失敗')
  })
})
