import { createCoachDomainClient } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

export type IdentityAssignmentService = Pick<
  ReturnType<typeof createCoachDomainClient>,
  | 'analytics'
  | 'rallyReplay'
  | 'assignTrackIdentity'
  | 'clearTrackIdentity'
  | 'applyReidAutomaticAssignments'
  | 'requestReidFeatureRebuild'
  | 'reidFeatureRebuildRequest'
  | 'requestReidAssociationRerun'
  | 'reidAssociationRerunRequest'
  | 'setTrackIdentityMappingComplete'
>

export function createIdentityAssignmentService(): IdentityAssignmentService {
  return createCoachDomainClient(createGraphQLTransport('/graphql'))
}
