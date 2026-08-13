interface OutcomeTeam {
  id: string
  name: string
  shortName?: string | null
}

export function annotationOutcomeLabel(input: {
  scoreResolution?: string | null
  scoringCourtSide?: string | null
  scoringTeamId?: string | null
  teams?: readonly OutcomeTeam[]
  leftLabel?: string | null
  rightLabel?: string | null
}) {
  if (!input.scoreResolution || input.scoreResolution === 'pending') return null
  if (input.scoreResolution === 'unknown') return '得分未知'

  const team = input.scoringTeamId
    ? input.teams?.find(candidate => candidate.id === input.scoringTeamId)
    : null
  const teamLabel = team?.shortName || team?.name
  const sideLabel = input.scoringCourtSide === 'left'
    ? input.leftLabel
    : input.scoringCourtSide === 'right'
      ? input.rightLabel
      : null
  const sidePrefix = input.scoringCourtSide === 'left'
    ? '左側'
    : input.scoringCourtSide === 'right'
      ? '右側'
      : null
  return sidePrefix
    ? `${sidePrefix} ${teamLabel || sideLabel || '隊伍'} 得分`
    : `${teamLabel || sideLabel || '得分隊'} 得分`
}
