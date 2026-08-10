import type { CreateMatchSetupInput } from '../lib/coreDomain'

export function validateMatchSetup(input: CreateMatchSetupInput): string[] {
  const errors: string[] = []
  if (!input.title.trim()) errors.push('請輸入場次名稱。')
  if (input.teams.length !== 2) return [...errors, '場次必須包含兩支參賽隊伍。']
  const [first, second] = input.teams
  if (!first!.name.trim() || !first!.shortName.trim()) errors.push('請完整填寫參賽隊伍 1 的名稱。')
  if (!second!.name.trim() || !second!.shortName.trim()) errors.push('請完整填寫參賽隊伍 2 的名稱。')
  const teamNames = input.teams.map(team => team.name.trim().toLocaleLowerCase())
  const shortNames = input.teams.map(team => team.shortName.trim().toLocaleLowerCase())
  if (teamNames[0] && teamNames[0] === teamNames[1]) errors.push('參賽隊伍名稱必須不同。')
  if (shortNames[0] && shortNames[0] === shortNames[1]) errors.push('參賽隊伍簡稱必須不同。')
  for (const [index, roster] of input.teams.map(team => team.roster).entries()) {
    const label = `參賽隊伍 ${index + 1}`
    const jerseys = roster.map((row) => row.jerseyNumber.trim()).filter(Boolean)
    if (new Set(jerseys).size !== jerseys.length) errors.push(`${label} 的背號不可重複。`)
    if (roster.some((row) => !row.name.trim() || !row.jerseyNumber.trim())) errors.push(`${label} 的球員姓名與背號都必填。`)
  }
  return errors
}
