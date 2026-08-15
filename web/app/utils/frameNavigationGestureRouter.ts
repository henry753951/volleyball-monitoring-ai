import type { FrameNavigationDirection } from '../composables/useCoalescedFrameNavigation'

export type FrameNavigationGestureOwner = 'player' | 'key-point'

interface FrameNavigationReleaseTarget {
  release: (direction: FrameNavigationDirection) => void
}

export function createFrameNavigationGestureRouter(
  targets: Record<FrameNavigationGestureOwner, FrameNavigationReleaseTarget>,
) {
  const owners = new Map<FrameNavigationDirection, FrameNavigationGestureOwner>()

  function claim(
    direction: FrameNavigationDirection,
    preferred: FrameNavigationGestureOwner,
  ): FrameNavigationGestureOwner {
    const owner = owners.get(direction) ?? preferred
    owners.set(direction, owner)
    return owner
  }

  function release(direction: FrameNavigationDirection) {
    const owner = owners.get(direction)
    owners.delete(direction)
    if (owner) {
      targets[owner].release(direction)
      return
    }
    // A lost keydown (focus change/HMR) must not leave either queue held.
    targets.player.release(direction)
    targets['key-point'].release(direction)
  }

  function clear(owner: FrameNavigationGestureOwner) {
    for (const [direction, current] of owners) {
      if (current === owner) owners.delete(direction)
    }
  }

  function releaseAll() {
    const claimed = [...owners]
    owners.clear()
    for (const [direction, owner] of claimed) targets[owner].release(direction)
  }

  function ownerOf(direction: FrameNavigationDirection) {
    return owners.get(direction) ?? null
  }

  return { claim, clear, ownerOf, release, releaseAll }
}
