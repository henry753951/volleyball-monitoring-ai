import { onScopeDispose, type MaybeRefOrGetter } from 'vue'
import {
  createAnalysisFrameChunksService,
  type AnalysisDataManifest,
} from '~/services/annotation-workstation/analysis-frame-chunks.service'

export type { AnalysisDataManifest }

export function useAnalysisFrameChunks(
  analysisRunId: MaybeRefOrGetter<string | null>,
  frame: MaybeRefOrGetter<number>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const service = createAnalysisFrameChunksService(analysisRunId, frame, enabled)
  onScopeDispose(service.dispose)
  return service
}
