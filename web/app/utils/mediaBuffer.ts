export type BufferedMediaElement = Pick<HTMLMediaElement, 'buffered' | 'currentTime'>

export function bufferedSecondsAhead(element: BufferedMediaElement) {
  for (let index = 0; index < element.buffered.length; index += 1) {
    const start = element.buffered.start(index)
    const end = element.buffered.end(index)
    if (element.currentTime >= start - 0.05 && element.currentTime <= end + 0.05) {
      return Math.max(0, end - element.currentTime)
    }
  }
  // `duration` describes the presentation timeline, not bytes currently held by
  // MSE. Returning duration here suppresses prefetch while the cursor is in an
  // unbuffered hole (or before the first fragment has arrived).
  return 0
}
