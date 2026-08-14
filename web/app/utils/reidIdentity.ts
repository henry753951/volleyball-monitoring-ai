export function formatReidTrackId(trackId: number) {
  return `T${String(trackId).padStart(3, '0')}`
}

export function formatReidGlobalId(label?: string | null) {
  if (!label) return 'G---'
  const fixedSlot = /^([LR])([1-6])$/.exec(label)
  if (fixedSlot) return `${fixedSlot[1]}${fixedSlot[2]}`
  return 'G---'
}

export function formatReidPair(trackId: number, gidLabel?: string | null) {
  return `${formatReidTrackId(trackId)}  ${formatReidGlobalId(gidLabel)}`
}
