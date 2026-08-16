import { inject, provide, type InjectionKey } from 'vue'
import {
  createIdentityAssignmentService,
  type IdentityAssignmentService,
} from '~/services/annotation-workstation/identity-assignment.service'

export { createIdentityAssignmentService, type IdentityAssignmentService }

const identityAssignmentServiceKey: InjectionKey<IdentityAssignmentService> = Symbol(
  'identity-assignment-service',
)

export function provideIdentityAssignmentService(
  service: IdentityAssignmentService = createIdentityAssignmentService(),
) {
  provide(identityAssignmentServiceKey, service)
  return service
}

export function useIdentityAssignmentService() {
  const service = inject(identityAssignmentServiceKey, null)
  if (!service)
    throw new Error('Identity assignment service was not provided by the route boundary')
  return service
}
