import { onScopeDispose, type Ref } from 'vue'
import {
  createDvrPlaybackService,
  requiresPlaybackPipelineReplacement,
} from '~/services/annotation-workstation/dvr-playback.service'

export { requiresPlaybackPipelineReplacement }

export function useDvrPlayback(
  video: Ref<HTMLVideoElement | null>,
  options: {
    onBufferActivity?: () => void
    onError?: (error: Error) => void
  } = {},
) {
  const { profile } = useMediaPlaybackPreferences()
  const service = createDvrPlaybackService(video, profile, options)
  onScopeDispose(service.dispose)
  return service
}
