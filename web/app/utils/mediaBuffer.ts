export type BufferedMediaElement = Pick<HTMLMediaElement, 'buffered' | 'currentTime' | 'duration'>

export function bufferedSecondsAhead(element: BufferedMediaElement) {
  for (let index = 0; index < element.buffered.length; index += 1) {
    const start = element.buffered.start(index)
    const end = element.buffered.end(index)
    if (element.currentTime >= start - 0.05 && element.currentTime <= end + 0.05) {
      return Math.max(0, end - element.currentTime)
    }
  }
  return Number.isFinite(element.duration)
    ? Math.max(0, element.duration - element.currentTime)
    : 0
}
