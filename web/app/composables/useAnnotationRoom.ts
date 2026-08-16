import { onScopeDispose } from 'vue'
import { createAnnotationRoomService } from '~/services/annotation-workstation/annotation-room.service'

export function useAnnotationRoom() {
  const { annotationWsUrl } = usePublicEndpoints()
  const service = createAnnotationRoomService(annotationWsUrl)

  onScopeDispose(service.dispose)

  return service
}
