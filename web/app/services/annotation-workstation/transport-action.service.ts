import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { WorkstationActionManager } from './workstation-action.service'

export interface TransportActionServiceOptions {
  manager: WorkstationActionManager
  playerReady: MaybeRefOrGetter<boolean>
  frameReady: MaybeRefOrGetter<boolean>
  frameMovePending: MaybeRefOrGetter<boolean>
  liveAvailable: MaybeRefOrGetter<boolean>
  correctionCreateEnabled: MaybeRefOrGetter<boolean>
  correctionCreateReason: MaybeRefOrGetter<string | null>
  correctionCreating: MaybeRefOrGetter<boolean>
  correctionCancelEnabled: MaybeRefOrGetter<boolean>
  correctionCancelling: MaybeRefOrGetter<boolean>
  processingRetryEnabled: MaybeRefOrGetter<boolean>
  navigableKeyPoints: MaybeRefOrGetter<boolean>
  navigableSegments: MaybeRefOrGetter<boolean>
  pointMoveEnabled: MaybeRefOrGetter<boolean>
  pointDeleteEnabled: MaybeRefOrGetter<boolean>
  clipDeleteEnabled: MaybeRefOrGetter<boolean>
  clipDownloadEnabled: MaybeRefOrGetter<boolean>
  togglePlayback: () => void | Promise<void>
  stepFrame: (direction: 'previous' | 'next', count?: number, input?: 'keyboard' | 'button') => void
  goLive: () => void | Promise<void>
  startCorrection: () => void | Promise<void>
  cancelCorrection: () => void | Promise<void>
  retryProcessing: () => void | Promise<void>
  navigateKeyPoint: (direction: 'previous' | 'next') => void | Promise<void>
  navigateSegment: (direction: 'previous' | 'next') => void | Promise<void>
  movePoint: (direction: 'previous' | 'next', count?: number, input?: 'keyboard' | 'button') => void
  deletePoint: () => void | Promise<void>
  deleteClip: () => void | Promise<void>
  downloadClip: () => void
  toggleMute: () => void
  setPlaybackRate: (rate: number) => void
  resetTimelineZoom: () => void
}

export function createTransportActionService(options: TransportActionServiceOptions) {
  const unregister = [
    options.manager.register({
      id: 'media.toggle-playback',
      group: 'media',
      label: '播放／暫停',
      shortcut: 'Space',
      availability: computed(() => ({
        enabled: toValue(options.playerReady),
        reason: '播放器尚未載入可用影片',
      })),
      execute: options.togglePlayback,
    }),
    ...(['previous', 'next'] as const).map(direction =>
      options.manager.register<{ count?: number; input?: 'keyboard' | 'button' } | undefined, void>(
        {
          id: direction === 'previous' ? 'media.frame-previous' : 'media.frame-next',
          group: 'media',
          label: direction === 'previous' ? '上一幀' : '下一幀',
          availability: computed(() => ({
            enabled: toValue(options.frameReady) && !toValue(options.frameMovePending),
            reason: toValue(options.frameMovePending) ? '擊球點正在同步' : '目前沒有可用畫格',
          })),
          execute: payload => options.stepFrame(direction, payload?.count, payload?.input),
        },
      ),
    ),
    options.manager.register({
      id: 'media.go-live',
      group: 'media',
      label: '前往直播',
      availability: computed(() => ({
        enabled: toValue(options.liveAvailable),
        reason: '目前沒有直播邊界',
      })),
      execute: options.goLive,
    }),
    ...(['previous', 'next'] as const).map(direction =>
      options.manager.register({
        id: direction === 'previous' ? 'media.key-point-previous' : 'media.key-point-next',
        group: 'media',
        label: direction === 'previous' ? '上一個球點' : '下一個球點',
        availability: computed(() => ({
          enabled: toValue(options.navigableKeyPoints),
          reason: '目前沒有可導覽的球點',
        })),
        execute: () => options.navigateKeyPoint(direction),
      }),
    ),
    ...(['previous', 'next'] as const).map(direction =>
      options.manager.register({
        id: direction === 'previous' ? 'media.segment-previous' : 'media.segment-next',
        group: 'media',
        label: direction === 'previous' ? '上一個片段' : '下一個片段',
        availability: computed(() => ({
          enabled: toValue(options.navigableSegments),
          reason: '目前沒有可導覽的片段',
        })),
        execute: () => options.navigateSegment(direction),
      }),
    ),
    options.manager.register({
      id: 'correction.create',
      group: 'correction',
      label: '建立修正版',
      resources: ['annotation-draft', 'analysis-review'],
      availability: computed(() => ({
        enabled: toValue(options.correctionCreateEnabled) && !toValue(options.correctionCreating),
        pending: toValue(options.correctionCreating),
        reason: toValue(options.correctionCreateReason) ?? '目前不能建立修正版',
      })),
      execute: options.startCorrection,
    }),
    options.manager.register({
      id: 'correction.cancel',
      group: 'correction',
      label: '取消修正版',
      resources: ['annotation-draft'],
      availability: computed(() => ({
        enabled: toValue(options.correctionCancelEnabled) && !toValue(options.correctionCancelling),
        pending: toValue(options.correctionCancelling),
        reason: '目前沒有可取消的修正版',
      })),
      execute: options.cancelCorrection,
    }),
    options.manager.register({
      id: 'processing.retry',
      group: 'processing',
      label: '重新處理',
      resources: ['rally-processing'],
      availability: computed(() => ({
        enabled: toValue(options.processingRetryEnabled),
        reason: '目前片段不需要重新處理',
      })),
      execute: options.retryProcessing,
    }),
    options.manager.register<
      | 'previous'
      | 'next'
      | { direction: 'previous' | 'next'; count?: number; input?: 'keyboard' | 'button' },
      void
    >({
      id: 'mark.move',
      group: 'marking',
      label: '微調球點',
      resources: ['annotation-draft'],
      availability: computed(() => ({
        enabled: toValue(options.pointMoveEnabled),
        reason: '請先選取可編輯球點',
      })),
      execute: payload =>
        typeof payload === 'string'
          ? options.movePoint(payload)
          : options.movePoint(payload.direction, payload.count, payload.input),
    }),
    options.manager.register({
      id: 'mark.delete',
      group: 'marking',
      label: '刪除球點',
      resources: ['annotation-draft'],
      availability: computed(() => ({
        enabled: toValue(options.pointDeleteEnabled),
        reason: '請先選取可刪除球點',
      })),
      execute: options.deletePoint,
    }),
    options.manager.register({
      id: 'segment.delete-processing',
      group: 'segment',
      label: '刪除片段內容',
      resources: ['annotation-draft', 'rally-processing'],
      availability: computed(() => ({
        enabled: toValue(options.clipDeleteEnabled),
        reason: '目前沒有可刪除片段',
      })),
      execute: options.deleteClip,
    }),
    options.manager.register({
      id: 'clip.download',
      group: 'clip',
      label: '下載片段',
      availability: computed(() => ({
        enabled: toValue(options.clipDownloadEnabled),
        reason: '片段尚未完成剪切',
      })),
      execute: options.downloadClip,
    }),
    options.manager.register({
      id: 'media.toggle-mute',
      group: 'media',
      label: '靜音／取消靜音',
      execute: options.toggleMute,
    }),
    options.manager.register<number, void>({
      id: 'media.set-rate',
      group: 'media',
      label: '播放速度',
      execute: options.setPlaybackRate,
    }),
    options.manager.register({
      id: 'timeline.reset-zoom',
      group: 'timeline',
      label: '重設時間軸縮放',
      execute: options.resetTimelineZoom,
    }),
  ]

  return { dispose: () => unregister.forEach(stop => stop()) }
}
