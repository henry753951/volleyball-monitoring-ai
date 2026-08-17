export function formatReidTrackId(trackId: number) {
  return `T${String(trackId).padStart(3, '0')}`
}

export function formatReidGlobalId(label?: string | null) {
  if (!label) return '群組未定'
  if (/^[LR][1-6]$/.test(label)) return '群組未定'
  return label.startsWith('GID ') ? `群組 ${label.slice(4)}` : `群組 ${label}`
}

/** A GID is an association key, not a player's display name. */
export function formatReidGroupCode(gidId?: string | null) {
  if (!gidId) return '未分群'
  return `GID ${gidId.replaceAll('-', '').slice(0, 8).toUpperCase()}`
}

export function formatReidPair(trackId: number, gidLabel?: string | null) {
  return `${formatReidTrackId(trackId)}  ${formatReidGlobalId(gidLabel)}`
}
