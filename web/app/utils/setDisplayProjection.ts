export interface SetDisplayProjectionResult {
  id: string
  set_number: number
  winning_team_id: string | null
  status?: string
}

export interface EffectiveSetWinner {
  setId: string
  teamId: string
}

export interface SetDisplayProjection {
  rawToEffective: ReadonlyMap<number, number>
  winnerByEffective: ReadonlyMap<number, EffectiveSetWinner>
}

/**
 * Set rows are durable result markers, while the visible set number is a
 * projection. A set without a winner does not create a boundary, so clearing
 * a winner merges its following raw set rows without rewriting any rally.
 */
export function deriveSetDisplayProjection(
  results: readonly SetDisplayProjectionResult[],
): SetDisplayProjection {
  const rawToEffective = new Map<number, number>()
  const winnerByEffective = new Map<number, EffectiveSetWinner>()
  let effectiveSetNumber = 1

  for (const result of [...results].sort((left, right) => left.set_number - right.set_number)) {
    rawToEffective.set(result.set_number, effectiveSetNumber)
    if (
      result.winning_team_id &&
      (result.status === undefined || result.status.toLowerCase() === 'finished')
    ) {
      winnerByEffective.set(effectiveSetNumber, {
        setId: result.id,
        teamId: result.winning_team_id,
      })
      effectiveSetNumber += 1
    }
  }

  return { rawToEffective, winnerByEffective }
}
