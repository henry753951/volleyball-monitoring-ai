export interface EffectiveContactFrameSource {
  keyPointId: string
  anchorFrameIndex: bigint
  resolvedFrameIndex: bigint | null
}

/**
 * Canonical effective-frame precedence shared by every read model.
 *
 * Human review is authoritative, then the persisted resolved frame produced by
 * analysis, and only then the original anchor. Keeping this in one helper
 * prevents the annotation timeline and replay projection from drifting apart.
 */
export function resolveEffectiveContactFrame(
  event: EffectiveContactFrameSource,
  timeCorrections: ReadonlyMap<string, bigint>,
) {
  return timeCorrections.get(event.keyPointId) ?? event.resolvedFrameIndex ?? event.anchorFrameIndex
}
