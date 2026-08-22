export interface CanonicalCourtPoint {
  x: number
  y: number
}

/**
 * Projects canonical court coordinates into a horizontal display court.
 *
 * The wire contract defines x from the left end line to the right end line
 * and y from the video's upper sideline to its lower sideline. Values outside
 * 0..1 are intentionally preserved so out-of-court events stay visible when
 * the SVG viewport includes them.
 */
export function projectCanonicalCourtPoint(
  point: CanonicalCourtPoint,
  width: number,
  height: number,
) {
  return {
    x: point.x * width,
    y: point.y * height,
  }
}
