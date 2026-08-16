import { inject, provide, type InjectionKey } from 'vue'
import type { createAnalysisReviewService } from './analysis-review.service'
import type { createAnalysisRevisionService } from './analysis-revision.service'
import type { createAnnotationRoomService } from './annotation-room.service'
import type { WorkstationActionManager } from './workstation-action.service'
import type { WorkstationFeedbackService } from './workstation-feedback.service'
import type { createWorkstationSelectionService } from './workstation-selection.service'
import type { createAnnotationWorkstationModelService } from './workstation-model.service'
import type { createIdentityAssignmentControllerService } from './identity-assignment-controller.service'
import type { createTimelineSelectionService } from './timeline-selection.service'
import type { createKeyPointEditingService } from './key-point-editing.service'
import type { createSegmentManagementService } from './segment-management.service'
import type { WorkstationConfirmationService } from './workstation-confirmation.service'
import type { SyncRecoveryService } from './sync-recovery.service'
import type { WorkstationPreferencesService } from './workstation-preferences.service'

export interface WorkstationPlaybackPort {
  togglePlayback: () => void | Promise<void>
  stepFrame: (direction: 'previous' | 'next', count?: number, input?: 'keyboard' | 'button') => void
  releaseFrame: (direction: 'previous' | 'next') => void
  navigateKeyPoint: (direction: 'previous' | 'next') => void | Promise<void>
  seek: (captureTimeUs: string) => void | Promise<void>
  previewSeek: (captureTimeUs: string | null) => void
  setRate: (rate: number) => void
}

export interface WorkstationVisualizationPort {
  setOverlayEnabled: (enabled: boolean) => void
  openSettings: (page?: 'root' | 'media' | 'overlay' | 'clip' | 'hotkeys') => void
}

type AnnotationRoomService = ReturnType<typeof createAnnotationRoomService>
type AnnotationWorkstationModelService = ReturnType<typeof createAnnotationWorkstationModelService>
type AnalysisReviewService = ReturnType<typeof createAnalysisReviewService>
type AnalysisRevisionService = ReturnType<typeof createAnalysisRevisionService>
type WorkstationSelectionService = ReturnType<typeof createWorkstationSelectionService>
type IdentityAssignmentControllerService = ReturnType<
  typeof createIdentityAssignmentControllerService
>
type TimelineSelectionService = ReturnType<typeof createTimelineSelectionService>
type KeyPointEditingService = ReturnType<typeof createKeyPointEditingService>
type SegmentManagementService = ReturnType<typeof createSegmentManagementService>

export interface AnnotationWorkstationService {
  annotation: {
    room: AnnotationRoomService
    model: AnnotationWorkstationModelService
    keyPoints: KeyPointEditingService | null
  }
  analysis: {
    review: AnalysisReviewService | null
    revision: AnalysisRevisionService | null
  }
  selection: WorkstationSelectionService
  timeline: TimelineSelectionService | null
  segments: SegmentManagementService | null
  sync: SyncRecoveryService | null
  playback: WorkstationPlaybackPort
  visualization: WorkstationVisualizationPort
  identity: IdentityAssignmentControllerService | null
  actions: WorkstationActionManager
  feedback: WorkstationFeedbackService
  confirmation: WorkstationConfirmationService | null
  preferences: WorkstationPreferencesService | null
  registerDisposable: (dispose: () => void) => () => void
  dispose: () => void
}

export interface AnnotationWorkstationServiceOptions {
  room: AnnotationRoomService
  model: AnnotationWorkstationModelService
  keyPointEditing?: KeyPointEditingService | null
  segments?: SegmentManagementService | null
  sync?: SyncRecoveryService | null
  selection: WorkstationSelectionService
  timeline?: TimelineSelectionService | null
  playback: WorkstationPlaybackPort
  visualization: WorkstationVisualizationPort
  analysisReview?: AnalysisReviewService | null
  analysisRevision?: AnalysisRevisionService | null
  identity?: IdentityAssignmentControllerService | null
  actions: WorkstationActionManager
  feedback: WorkstationFeedbackService
  confirmation?: WorkstationConfirmationService | null
  preferences?: WorkstationPreferencesService | null
}

export function createAnnotationWorkstationService(
  options: AnnotationWorkstationServiceOptions,
): AnnotationWorkstationService {
  const feedback = options.feedback
  const actions = options.actions
  const disposables: Array<() => void> = []
  let disposed = false

  const unregisterBuiltInActions = [
    actions.register<boolean, void>({
      id: 'visualization.toggle-overlay',
      group: 'visualization',
      label: '顯示 Overlay',
      execute: enabled => options.visualization.setOverlayEnabled(enabled),
    }),
    actions.register<'root' | 'media' | 'overlay' | 'clip' | 'hotkeys' | undefined, void>({
      id: 'visualization.open-settings',
      group: 'visualization',
      label: '工作站設定',
      execute: page => options.visualization.openSettings(page),
    }),
  ]

  function registerDisposable(dispose: () => void) {
    if (disposed) {
      dispose()
      return () => undefined
    }
    disposables.push(dispose)
    return () => {
      const index = disposables.indexOf(dispose)
      if (index >= 0) disposables.splice(index, 1)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    unregisterBuiltInActions.forEach(unregister => unregister())
    for (const cleanup of disposables.splice(0).reverse()) cleanup()
    actions.dispose()
  }

  return {
    annotation: {
      room: options.room,
      model: options.model,
      keyPoints: options.keyPointEditing ?? null,
    },
    analysis: {
      review: options.analysisReview ?? null,
      revision: options.analysisRevision ?? null,
    },
    selection: options.selection,
    timeline: options.timeline ?? null,
    segments: options.segments ?? null,
    sync: options.sync ?? null,
    playback: options.playback,
    visualization: options.visualization,
    identity: options.identity ?? null,
    actions,
    feedback,
    confirmation: options.confirmation ?? null,
    preferences: options.preferences ?? null,
    registerDisposable,
    dispose,
  }
}

export const annotationWorkstationServiceKey: InjectionKey<AnnotationWorkstationService> = Symbol(
  'annotation-workstation-service',
)

export function provideAnnotationWorkstationService(service: AnnotationWorkstationService) {
  provide(annotationWorkstationServiceKey, service)
  return service
}

export function useAnnotationWorkstationService() {
  const service = inject(annotationWorkstationServiceKey, null)
  if (!service) {
    throw new Error('Annotation workstation service was not provided by the route boundary')
  }
  return service
}
