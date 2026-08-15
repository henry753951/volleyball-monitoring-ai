export function formatReidTrackId(trackId: number) {
  return `T${String(trackId).padStart(3, '0')}`
}

export function formatReidGlobalId(label?: string | null) {
  if (!label) return '群組未定'
  const fixedSlot = /^([LR])([1-6])$/.exec(label)
  if (fixedSlot) return `舊關聯 ${fixedSlot[1]}${fixedSlot[2]}`
  return label.startsWith('GID ') ? `群組 ${label.slice(4)}` : `群組 ${label}`
}

export function formatReidPair(trackId: number, gidLabel?: string | null) {
  return `${formatReidTrackId(trackId)}  ${formatReidGlobalId(gidLabel)}`
}
