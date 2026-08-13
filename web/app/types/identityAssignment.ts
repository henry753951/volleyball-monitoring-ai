export type IdentityMode = 'from_here' | 'clip_only' | 'split_identity'

export interface PlayerComboboxOption {
  value: string
  label: string
  description?: string
  tone?: 'default' | 'occupied' | 'suggested'
}

export interface IdentityReplacementRequest {
  trackId: number
  rosterEntryId: string
  playerName: string
  occupiedTrackId: number
}

export interface IdentityCorrectionRequest {
  trackId: number
  rosterEntryId: string
  playerName: string
}

export interface IdentityAssignmentCommand {
  trackId: number
  rosterEntryId: string
  identityMode?: IdentityMode
}
