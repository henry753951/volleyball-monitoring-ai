import type { MediaClient } from '~/lib/mediaClient'
import { createAuthoritativeDvrWindowService } from '~/services/annotation-workstation/authoritative-dvr-window.service'

export {
  authoritativeControlsEnabled,
  boundedPlayerSeconds,
  frameCommandEnabled,
  frameRecovery,
  seekVideoToCanonicalFrame,
  type WindowStatus,
} from '~/services/annotation-workstation/authoritative-dvr-window.service'

export function useAuthoritativeDvrWindow(client: MediaClient) {
  return createAuthoritativeDvrWindowService(client)
}
