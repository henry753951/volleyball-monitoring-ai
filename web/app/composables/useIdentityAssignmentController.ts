import { onScopeDispose } from 'vue'
import { useIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'
import {
  createIdentityAssignmentControllerService,
  type IdentityAssignmentControllerOptions,
} from '~/services/annotation-workstation/identity-assignment-controller.service'

export type { IdentityAssignmentControllerOptions }

export function useIdentityAssignmentController(options: IdentityAssignmentControllerOptions) {
  const service = useIdentityAssignmentService()
  const controller = createIdentityAssignmentControllerService(options, service)
  onScopeDispose(controller.dispose)
  return controller
}
