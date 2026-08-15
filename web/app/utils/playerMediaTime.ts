export function boundedPlayerMediaSeconds(value: string): number {
  const targetUs = BigInt(value)
  if (targetUs < 0n || targetUs > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('player media time exceeds safe bounded range')
  return Number(targetUs) / 1_000_000
}
