export type CoachHighlightFingerprintEvent = {
  event_id: string
  rally_id: string
  clip_job_id: string
  clip_duration_us: string
  anchor_time_us: string
  set_number: number
  rally_ordinal: number
  action_key: string
  action_label: string
}

export function coachHighlightFingerprintSource(input: {
  subjectLabel: string
  filterLabel: string
  events: CoachHighlightFingerprintEvent[]
}) {
  return JSON.stringify([
    input.subjectLabel,
    input.filterLabel,
    input.events.map(event => [
      event.event_id,
      event.rally_id,
      event.clip_job_id,
      event.clip_duration_us,
      event.anchor_time_us,
      event.set_number,
      event.rally_ordinal,
      event.action_key,
      event.action_label,
    ]),
  ])
}

export async function coachHighlightFingerprint(input: {
  subjectLabel: string
  filterLabel: string
  events: CoachHighlightFingerprintEvent[]
}) {
  const bytes = new TextEncoder().encode(coachHighlightFingerprintSource(input))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}
