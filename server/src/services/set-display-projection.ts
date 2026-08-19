export type SetDisplayProjectionInput = {
  setNumber: number
  status?: string
  winningTeamId: string | null
}

/**
 * Raw MatchSet rows are retained for auditability. The UI must use the
 * logical set number derived from the durable winner markers instead of the
 * historical row number, otherwise deleting a winner leaves empty set tabs.
 */
export function deriveEffectiveSetNumberMap(
  sets: readonly SetDisplayProjectionInput[] | null | undefined,
): ReadonlyMap<number, number> {
  const rawToEffective = new Map<number, number>()
  let effectiveSetNumber = 1
  for (const set of [...(sets ?? [])].sort((left, right) => left.setNumber - right.setNumber)) {
    rawToEffective.set(set.setNumber, effectiveSetNumber)
    if (
      set.winningTeamId &&
      (set.status === undefined || set.status.toLowerCase() === 'finished')
    ) {
      effectiveSetNumber += 1
    }
  }
  return rawToEffective
}
