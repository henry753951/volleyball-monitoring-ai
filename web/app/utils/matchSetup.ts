import type { CreateMatchSetupInput } from '../lib/coreDomain'

export function validateMatchSetup(input: CreateMatchSetupInput): string[] {
  const errors: string[] = []
  if (!input.title.trim()) errors.push('請輸入場次名稱。')
  const left = input.leftTeam
  const right = input.rightTeam
  if (!left.name.trim() || !left.shortName.trim()) errors.push('請完整填寫左側隊伍名稱。')
  if (!right.name.trim() || !right.shortName.trim()) errors.push('請完整填寫右側隊伍名稱。')
  const teamNames = [left.name, right.name].map((name) => name.trim().toLocaleLowerCase())
  const shortNames = [left.shortName, right.shortName].map((name) => name.trim().toLocaleLowerCase())
  if (teamNames[0] && teamNames[0] === teamNames[1]) errors.push('左右隊伍名稱必須不同。')
  if (shortNames[0] && shortNames[0] === shortNames[1]) errors.push('左右隊伍簡稱必須不同。')
  for (const [label, roster] of [['左側', left.roster], ['右側', right.roster]] as const) {
    const jerseys = roster.map((row) => row.jerseyNumber.trim()).filter(Boolean)
    if (new Set(jerseys).size !== jerseys.length) errors.push(`${label}隊伍的背號不可重複。`)
    if (roster.some((row) => !row.name.trim() || !row.jerseyNumber.trim())) errors.push(`${label}隊伍的球員姓名與背號都必填。`)
    if (roster.some(row => row.position === 'UNSPECIFIED')) errors.push(`${label}隊伍的球員位置都必須選擇。`)
  }
  return errors
}
