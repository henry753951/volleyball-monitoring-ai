export interface CoachEventReplayWindow {
  eventSeconds: number
  startSeconds: number
  endSeconds: number
}

function secondsFromMicroseconds(value: string | null | undefined) {
  return value && /^\d+$/.test(value) ? Number(BigInt(value)) / 1_000_000 : 0
}

export function coachEventReplayWindow(
  anchorTimeUs: string,
  clipDurationUs: string | null | undefined,
  leadSeconds = 3,
  tailSeconds = 2,
): CoachEventReplayWindow {
  const eventSeconds = secondsFromMicroseconds(anchorTimeUs)
  const clipDurationSeconds = secondsFromMicroseconds(clipDurationUs)
  const safeLead = Number.isFinite(leadSeconds) ? Math.max(0, leadSeconds) : 3
  const safeTail = Number.isFinite(tailSeconds) ? Math.max(0, tailSeconds) : 2
  const startSeconds = Math.max(0, eventSeconds - safeLead)
  const requestedEnd = Math.max(startSeconds, eventSeconds + safeTail)
  const endSeconds =
    clipDurationSeconds > 0 ? Math.min(clipDurationSeconds, requestedEnd) : requestedEnd
  return { eventSeconds, startSeconds, endSeconds: Math.max(startSeconds, endSeconds) }
}

export function coachEventReplayMediaUrl(
  source: string,
  window: Pick<CoachEventReplayWindow, 'startSeconds' | 'endSeconds'>,
) {
  const base = source.split('#')[0]
  return `${base}#t=${window.startSeconds.toFixed(3)},${window.endSeconds.toFixed(3)}`
}
