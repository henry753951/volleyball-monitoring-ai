export function formatReidTrackId(trackId: number) {
  return `T${String(trackId).padStart(3, '0')}`
}

export function formatReidGlobalId(label?: string | null) {
  if (!label) return 'G---'
  const sequential = /^G([0-9]+)$/.exec(label)
  return sequential ? `G${sequential[1]!.padStart(3, '0')}` : label
}

export function formatReidPair(trackId: number, gidLabel?: string | null) {
  return `${formatReidTrackId(trackId)}  ${formatReidGlobalId(gidLabel)}`
}
