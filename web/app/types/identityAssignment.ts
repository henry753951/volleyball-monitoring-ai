import type { RosterPosition } from '~/lib/coreDomain'

export type IdentityMode = 'from_here' | 'clip_only' | 'split_identity'

export interface PlayerComboboxOption {
  value: string
  label: string
  jerseyNumber?: string
  playerName?: string
  position?: RosterPosition
  description?: string
  tone?: 'default' | 'occupied' | 'suggested'
}

export interface IdentityCorrectionRequest {
  trackId: number
  rosterEntryId: string
  playerName: string
  previousPlayerName: string | null
  occupiedGidLabel: string | null
  occupiedTrackId: number | null
  swapCandidates: Array<{
    gidId: string
    gidLabel: string
    representativeTrackId: number
    setNumber: number
    rallyOrdinal: number
  }>
}

export interface IdentityAssignmentCommand {
  trackId: number
  rosterEntryId: string | null
  identityMode?: IdentityMode
  scope?: 'local' | 'gid'
  trackIds?: number[]
}
