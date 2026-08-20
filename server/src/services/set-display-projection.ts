export type SetDisplayProjectionInput = {
  setNumber: number
  status?: string
  winningTeamId: string | null
}

export interface EffectiveSetRow<T extends SetDisplayProjectionInput> {
  row: T
  setNumber: number
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

/**
 * Collapse historical MatchSet rows into the logical sets that are visible to
 * operators. A MatchSet without a winner marker is not a set boundary. This
 * is intentionally a projection only: the raw rows remain available for
 * audit/recovery, but they must not leak into scoreboards or set tabs.
 */
export function deriveEffectiveSetRows<T extends SetDisplayProjectionInput>(
  rows: readonly T[] | null | undefined,
): EffectiveSetRow<T>[] {
  const ordered = [...(rows ?? [])].sort((left, right) => left.setNumber - right.setNumber)
  const rawToEffective = deriveEffectiveSetNumberMap(ordered)
  const latestByEffective = new Map<number, T>()

  for (const row of ordered) {
    const setNumber = rawToEffective.get(row.setNumber) ?? row.setNumber
    latestByEffective.set(setNumber, row)
  }

  return [...latestByEffective.entries()]
    .sort(([left], [right]) => left - right)
    .map(([setNumber, row]) => ({ row, setNumber }))
}
