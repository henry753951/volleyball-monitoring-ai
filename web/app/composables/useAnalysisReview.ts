import type { MaybeRefOrGetter } from 'vue'
import { onScopeDispose } from 'vue'
import { createAnalysisReviewService } from '~/services/annotation-workstation/analysis-review.service'

export type { BallOverride } from '~/services/annotation-workstation/analysis-review.service'

export function useAnalysisReview(analysisRunId: MaybeRefOrGetter<string | null>) {
  const { analysisReviewWsUrl } = usePublicEndpoints()
  const service = createAnalysisReviewService(analysisRunId, { analysisReviewWsUrl })

  onScopeDispose(service.dispose)

  return service
}
