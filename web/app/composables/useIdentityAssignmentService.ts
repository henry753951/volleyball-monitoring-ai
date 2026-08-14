import { inject, provide, type InjectionKey } from 'vue'
import { createCoachDomainClient } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

export type IdentityAssignmentService = Pick<
  ReturnType<typeof createCoachDomainClient>,
  'analytics' | 'rallyReplay' | 'assignTrackIdentity' | 'clearTrackIdentity' | 'applyReidAutomaticAssignments' | 'setTrackIdentityMappingComplete'
>

const identityAssignmentServiceKey: InjectionKey<IdentityAssignmentService> = Symbol('identity-assignment-service')

export function createIdentityAssignmentService(): IdentityAssignmentService {
  return createCoachDomainClient(createGraphQLTransport('/graphql'))
}

export function provideIdentityAssignmentService(
  service: IdentityAssignmentService = createIdentityAssignmentService(),
) {
  provide(identityAssignmentServiceKey, service)
  return service
}

export function useIdentityAssignmentService() {
  return inject(identityAssignmentServiceKey, null) ?? createIdentityAssignmentService()
}
