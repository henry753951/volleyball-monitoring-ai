import {
  createCoalescedFrameNavigationService,
  type CoalescedFrameNavigationOptions,
} from '~/services/annotation-workstation/coalesced-frame-navigation.service'

export type {
  CoalescedFrameNavigationOptions,
  FrameNavigationDirection,
} from '~/services/annotation-workstation/coalesced-frame-navigation.service'

export function useCoalescedFrameNavigation<T>(options: CoalescedFrameNavigationOptions<T>) {
  return createCoalescedFrameNavigationService(options)
}
