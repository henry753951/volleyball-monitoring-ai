export interface CoachRallyStatus {
  setNumber: number
  rallyOrdinal: number
  currentTime: string
  duration: string
  contactCount: number
  activePath: number | null
  pathCount: number
  analysisState: 'ready' | 'mapped'
}

export function useCoachRallyStatus() {
  return useState<CoachRallyStatus | null>('coach-rally-status', () => null)
}
