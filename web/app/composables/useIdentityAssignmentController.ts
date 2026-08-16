import { onScopeDispose } from 'vue'
import { useIdentityAssignmentService } from '~/composables/useIdentityAssignmentService'
import { useIdentityReplacementWarning } from '~/composables/useIdentityReplacementWarning'
import {
  createIdentityAssignmentControllerService,
  type IdentityAssignmentControllerOptions,
} from '~/services/annotation-workstation/identity-assignment-controller.service'

export type { IdentityAssignmentControllerOptions }

export function useIdentityAssignmentController(options: IdentityAssignmentControllerOptions) {
  const service = useIdentityAssignmentService()
  const replacementWarning = useIdentityReplacementWarning()
  const controller = createIdentityAssignmentControllerService(
    options,
    service,
    replacementWarning.enabled,
  )
  onScopeDispose(controller.dispose)
  return controller
}
