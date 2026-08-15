import { createHash } from 'node:crypto'

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SHA256_PATTERN = /^[a-f0-9]{64}$/i

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function contentAddressedDocument<T extends Record<string, unknown>>(
  value: T,
): T & { content_sha256: string } {
  return { ...value, content_sha256: sha256Hex(canonicalJson(value)) }
}

export function verifiedSemanticContentSha(value: Record<string, unknown>, kind: string): string {
  const claimed = value.content_sha256
  if (typeof claimed !== 'string' || !SHA256_PATTERN.test(claimed))
    throw new TypeError(`${kind} content hash is invalid`)
  const body = { ...value }
  delete body.content_sha256
  const actual = sha256Hex(canonicalJson(body))
  if (actual !== claimed.toLowerCase()) throw new TypeError(`${kind} content hash does not match`)
  return actual
}

export type ReidRosterInput = {
  snapshotId: string
  matchId: string
  submissionId: string
  setNumber: number
  rallyOrdinal: number
  leftTeamId: string
  rightTeamId: string
  entries: Array<{
    id: string
    teamId: string
    playerId: string | null
    jerseyNumber: string
    displayNameSnapshot: string | null
    position: string
    active: boolean
  }>
}

export function buildReidRosterSnapshot(input: ReidRosterInput) {
  const byTeam = (teamId: string) =>
    input.entries
      .filter(entry => entry.teamId === teamId)
      .sort((left, right) =>
        left.jerseyNumber.localeCompare(right.jerseyNumber, undefined, { numeric: true }),
      )
      .map(entry => ({
        roster_entry_id: entry.id,
        player_id: entry.playerId,
        jersey_number: entry.jerseyNumber,
        display_name: entry.displayNameSnapshot,
        position: entry.position,
        active: entry.active,
      }))
  return contentAddressedDocument({
    schema_version: '1.0.0',
    roster_snapshot_id: input.snapshotId,
    match_id: input.matchId,
    rally_submission_id: input.submissionId,
    as_of_position: { set_number: input.setNumber, rally_ordinal: input.rallyOrdinal },
    teams: [
      { team_id: input.leftTeamId, court_side: 'LEFT', entries: byTeam(input.leftTeamId) },
      { team_id: input.rightTeamId, court_side: 'RIGHT', entries: byTeam(input.rightTeamId) },
    ],
  })
}

export function featureRecipeNamespace(
  frameSelectionRecipe: string,
  recipes: Array<{ modality: string; model_namespace: string }>,
): string {
  const digest = sha256Hex(
    canonicalJson({
      frame_selection_recipe_version: frameSelectionRecipe,
      requested_recipes: recipes,
    }),
  )
  return `reid-feature-set/${digest}`
}

export type ReidBankSnapshotInput = {
  snapshotId: string
  matchId: string
  teamId: string
  revision: bigint
  setNumber: number
  rallyOrdinal: number
  clusters: Array<{ personClusterId: string; rosterEntryId: string | null }>
  artifacts: Array<{ artifactId: string; sha256: string; byteLength: bigint }>
  vectors: Array<{
    vectorId: string
    artifactId: string
    modality: string
    modelNamespace: string
    dimension: number
    normalization: string
    distance: string
    byteOffset: bigint
    byteLength: bigint
    sha256: string
  }>
  memberships: Array<{
    membershipId: string
    personClusterId: string
    trackletId: string
    vectorIds: string[]
    evidenceRole: string
    weight: number
    sourceRevision: bigint
    rosterEntryId: string | null
  }>
  cannotLinks: Array<{ leftTrackletId: string; rightTrackletId: string; reason: string }>
}

export function buildReidBankSnapshot(input: ReidBankSnapshotInput) {
  return contentAddressedDocument({
    schema_version: '1.1.0',
    bank_snapshot_id: input.snapshotId,
    match_id: input.matchId,
    team_id: input.teamId,
    revision: input.revision.toString(),
    as_of_position: { set_number: input.setNumber, rally_ordinal: input.rallyOrdinal },
    clusters: [...input.clusters]
      .sort((left, right) => left.personClusterId.localeCompare(right.personClusterId))
      .map(cluster => ({
        person_cluster_id: cluster.personClusterId,
        roster_entry_id: cluster.rosterEntryId,
      })),
    evidence_artifacts: [...input.artifacts]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
      .map(artifact => ({
        artifact_id: artifact.artifactId,
        sha256: artifact.sha256.toLowerCase(),
        byte_length: artifact.byteLength.toString(),
      })),
    vectors: [...input.vectors]
      .sort((left, right) => left.vectorId.localeCompare(right.vectorId))
      .map(vector => ({
        vector_id: vector.vectorId,
        artifact_id: vector.artifactId,
        modality: vector.modality,
        model_namespace: vector.modelNamespace,
        dimension: vector.dimension,
        normalization: vector.normalization,
        distance: vector.distance,
        byte_offset: vector.byteOffset.toString(),
        byte_length: vector.byteLength.toString(),
        sha256: vector.sha256.toLowerCase(),
      })),
    memberships: [...input.memberships]
      .sort((left, right) => left.membershipId.localeCompare(right.membershipId))
      .map(membership => ({
        membership_id: membership.membershipId,
        person_cluster_id: membership.personClusterId,
        tracklet_id: membership.trackletId,
        vector_ids: [...membership.vectorIds].sort(),
        evidence_state: 'CONFIRMED',
        evidence_role: membership.evidenceRole,
        weight: membership.weight,
        source_revision: membership.sourceRevision.toString(),
        roster_entry_id: membership.rosterEntryId,
      })),
    cannot_links: [...input.cannotLinks]
      .map(link => ({
        left_tracklet_id: [link.leftTrackletId, link.rightTrackletId].sort()[0]!,
        right_tracklet_id: [link.leftTrackletId, link.rightTrackletId].sort()[1]!,
        reason: link.reason,
      }))
      .sort((left, right) =>
        `${left.left_tracklet_id}:${left.right_tracklet_id}`.localeCompare(
          `${right.left_tracklet_id}:${right.right_tracklet_id}`,
        ),
      ),
  })
}
