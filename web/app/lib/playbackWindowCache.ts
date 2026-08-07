import type { PlaybackWindowDescriptor } from './mediaModel'
export type WindowSlot = 'current' | 'previous' | 'next'
export class PlaybackWindowCache {
  private slots: Partial<Record<WindowSlot, PlaybackWindowDescriptor>> = {}
  constructor(private readonly cleanup: (descriptor: PlaybackWindowDescriptor) => void = () => {}) {}
  get(slot: WindowSlot) { return this.slots[slot] }
  set(slot: WindowSlot, descriptor: PlaybackWindowDescriptor) {
    const old = this.slots[slot]; if (old && old.playback_window_id !== descriptor.playback_window_id) this.cleanup(old)
    this.slots[slot] = descriptor
    return descriptor
  }
  recenter(descriptor: PlaybackWindowDescriptor) {
    const retainedId = descriptor.playback_window_id
    const cleaned = new Set<string>()
    for (const value of Object.values(this.slots)) {
      if (value && value.playback_window_id !== retainedId && !cleaned.has(value.playback_window_id)) { this.cleanup(value); cleaned.add(value.playback_window_id) }
    }
    this.slots = { current: descriptor }; return descriptor
  }
  evict(slot: WindowSlot) { const old = this.slots[slot]; if (old) this.cleanup(old); delete this.slots[slot] }
  clear() { const cleaned = new Set<string>(); for (const value of Object.values(this.slots)) if (value && !cleaned.has(value.playback_window_id)) { this.cleanup(value); cleaned.add(value.playback_window_id) }; this.slots = {} }
  snapshot() { return { ...this.slots } }
}
