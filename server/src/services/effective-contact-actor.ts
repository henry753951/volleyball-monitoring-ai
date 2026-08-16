export interface EffectiveContactActorAnalysis {
  contactEvents: ReadonlyArray<{
    keyPointId: string
    sourceKeyPointId: string | null
    sequenceIndex: number
    associationState: string
    actors: ReadonlyArray<{ trackId: number; associationConfidence: number | null }>
  }>
  contactActorCorrections: ReadonlyArray<{ keyPointId: string; trackId: number | null }>
  contactAssociationJobs: ReadonlyArray<{
    keyPointId: string
    status: string
    projection: { trackId: number | null } | null
  }>
  tracks: ReadonlyArray<{
    trackId: number
    identityAssignments: ReadonlyArray<{ rosterEntryId: string }>
  }>
  reidEvidenceSets: ReadonlyArray<{
    tracklets: ReadonlyArray<{
      canonicalTrackId: number
      trackIdAliases: ReadonlyArray<number>
      activeProjection: {
        assignmentRevision: { rosterEntryId: string | null }
      } | null
    }>
  }>
}

export interface SubmittedContactActorSemantic {
  submissionKeyPointId: string
  ordinal: number
  actorRosterEntryId: string | null
}

function effectiveRosterEntryByTrack(analysis: EffectiveContactActorAnalysis) {
  const rosterEntryByTrack = new Map<number, string>()
  for (const track of analysis.tracks) {
    const legacyRosterEntryId = track.identityAssignments[0]?.rosterEntryId
    if (legacyRosterEntryId) rosterEntryByTrack.set(track.trackId, legacyRosterEntryId)
  }

  // The versioned ReID projection is current truth. A projection with a null
  // roster entry deliberately clears any older, compatibility assignment.
  for (const tracklet of analysis.reidEvidenceSets[0]?.tracklets ?? []) {
    const trackIds = new Set([tracklet.canonicalTrackId, ...tracklet.trackIdAliases])
    const rosterEntryId = tracklet.activeProjection?.assignmentRevision.rosterEntryId ?? null
    for (const trackId of trackIds) {
      if (rosterEntryId) rosterEntryByTrack.set(trackId, rosterEntryId)
      else if (tracklet.activeProjection) rosterEntryByTrack.delete(trackId)
    }
  }
  return rosterEntryByTrack
}

/**
 * Resolves the editable actor default for a submitted contact.
 *
 * An explicit submitted roster actor is immutable human truth and always wins.
 * Otherwise the current analyzed projection is resolved in the same order as
 * replay: manual track correction, latest association job, then one resolved
 * model actor. Ambiguous or unmapped tracks remain unassigned.
 */
export function resolveEffectiveContactActorRosterEntryId(
  analysis: EffectiveContactActorAnalysis | null,
  semantic: SubmittedContactActorSemantic,
) {
  if (semantic.actorRosterEntryId) return semantic.actorRosterEntryId
  if (!analysis) return null

  const event =
    analysis.contactEvents.find(
      candidate =>
        candidate.sourceKeyPointId === semantic.submissionKeyPointId ||
        candidate.keyPointId === semantic.submissionKeyPointId,
    ) ??
    analysis.contactEvents.find(candidate => candidate.sequenceIndex === semantic.ordinal - 1) ??
    null
  if (!event) return null

  const actorCorrection = analysis.contactActorCorrections.find(
    correction => correction.keyPointId === event.keyPointId,
  )
  let trackId: number | null
  if (actorCorrection) {
    trackId = actorCorrection.trackId
  } else {
    const latestAssociation = analysis.contactAssociationJobs.find(
      job =>
        job.keyPointId === semantic.submissionKeyPointId || job.keyPointId === event.keyPointId,
    )
    if (latestAssociation) {
      trackId =
        latestAssociation.status === 'COMPLETED'
          ? (latestAssociation.projection?.trackId ?? null)
          : null
    } else if (event.associationState === 'RESOLVED_SINGLE') {
      trackId =
        event.actors
          .toSorted(
            (left, right) =>
              (right.associationConfidence ?? -1) - (left.associationConfidence ?? -1),
          )
          .at(0)?.trackId ?? null
    } else {
      trackId = null
    }
  }

  return trackId === null ? null : (effectiveRosterEntryByTrack(analysis).get(trackId) ?? null)
}
