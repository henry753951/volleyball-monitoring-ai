import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AnnotationProcessingBadge from './AnnotationProcessingBadge.vue'

describe('AnnotationProcessingBadge', () => {
  it('shows a leased provider job as active analysis instead of waiting for a worker', async () => {
    const wrapper = mount(AnnotationProcessingBadge, {
      props: {
        label: 'AI 分析中',
        processing: {
          schema_version: '2.0.0',
          type: 'rally_processing_update',
          room_id: 'match:match-1:capture:capture-1',
          rally_id: 'rally-1',
          submission_id: 'submission-1',
          processing_status: 'ai_queued',
          stage: 'volleyball_multitask_tracking',
          progress: 0.42,
          ai_job_id: 'cdc8e98d-bdcc-4e85-ae04-d17ee48069f8',
          worker_instance_key: 'analysis-worker-rtx5070',
          provider_build_id: 'test-build',
          analysis_id: null,
          analysis_data_version: null,
          error: null,
          updated_at: new Date().toISOString(),
        } as never,
      },
    })

    await wrapper.get('button.processing-badge').trigger('click')

    expect(wrapper.text()).toContain('分析階段進行中')
    expect(wrapper.text()).toContain('analysis-worker-rtx5070 · test-build')
    expect(wrapper.text()).not.toContain('等待可用 AI Worker')
  })

  it('shows provider ReID failures in the analysis phase instead of the clip phase', async () => {
    const wrapper = mount(AnnotationProcessingBadge, {
      props: {
        label: '處理失敗',
        processing: {
          schema_version: '1.0.0',
          rally_id: 'rally-1',
          processing_status: 'failed',
          processing_revision: 4,
          stage: 'hit_association',
          progress: 0.76,
          ai_job_id: 'cdc8e98d-bdcc-4e85-ae04-d17ee48069f8',
          worker_instance_key: 'analysis-worker-rtx5070',
          provider_build_id: 'test-build',
          error: {
            code: 'PROVIDER_ANALYSIS_FAILED',
            message: 'contact association failed at frame 46',
            attempt_count: 1,
            max_attempts: 5,
          },
          updated_at: new Date().toISOString(),
        } as never,
      },
    })

    await wrapper.get('button.processing-badge').trigger('click')

    expect(wrapper.text()).toContain('分析階段失敗')
    expect(wrapper.text()).toContain('正在將擊球標記與球員、球路事件建立關聯')
    expect(wrapper.text()).not.toContain('剪切階段失敗')
    expect(wrapper.text()).not.toContain('剪切工作未完成')
  })
})
