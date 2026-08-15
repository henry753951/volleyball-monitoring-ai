function reuseMetadata(requestPayload: unknown): Record<string, unknown> | null {
  if (
    !requestPayload ||
    typeof requestPayload !== 'object' ||
    Array.isArray(requestPayload) ||
    !('reuse' in requestPayload)
  )
    return null
  const reuse = requestPayload.reuse
  return reuse && typeof reuse === 'object' && !Array.isArray(reuse)
    ? (reuse as Record<string, unknown>)
    : null
}

export function resolveOverlayAnalysisId(analysisId: string, requestPayload: unknown) {
  const sourceAnalysisId = reuseMetadata(requestPayload)?.source_analysis_id
  return typeof sourceAnalysisId === 'string' && sourceAnalysisId.length > 0
    ? sourceAnalysisId
    : analysisId
}

export function resolveOverlaySourceAnalysisRunId(requestPayload: unknown) {
  const sourceAnalysisRunId = reuseMetadata(requestPayload)?.source_analysis_run_id
  return typeof sourceAnalysisRunId === 'string' && sourceAnalysisRunId.length > 0
    ? sourceAnalysisRunId
    : null
}
