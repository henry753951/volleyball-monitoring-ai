import { describe, expect, it } from 'vitest'
import { validateMatchSetup } from './matchSetup'

const valid = {
  title: '決賽',
  teams: [
    { name: '北隊', shortName: 'N', roster: [{ name: '甲', jerseyNumber: '1', position: 'OH' as const }] },
    { name: '南隊', shortName: 'S', roster: [{ name: '乙', jerseyNumber: '1', position: 'L' as const }] },
  ],
}

describe('match setup validation', () => {
  it('accepts two complete teams', () => expect(validateMatchSetup(valid)).toEqual([]))
  it('accepts teams without an initial roster', () => {
    expect(validateMatchSetup({
      ...valid,
      teams: valid.teams.map(team => ({ ...team, roster: [] })),
    })).toEqual([])
  })
  it('rejects duplicate teams and jerseys within one team', () => {
    expect(validateMatchSetup({ ...valid, teams: [valid.teams[0]!, { ...valid.teams[0]!, roster: [{ name: '乙', jerseyNumber: '1', position: 'MB' }, { name: '丙', jerseyNumber: '1', position: 'S' }] }] })).toEqual(expect.arrayContaining(['參賽隊伍名稱必須不同。', '參賽隊伍簡稱必須不同。', '參賽隊伍 2 的背號不可重複。']))
  })
  it('requires every player position', () => {
    expect(validateMatchSetup({ ...valid, teams: [{ ...valid.teams[0]!, roster: [{ ...valid.teams[0]!.roster[0]!, position: 'UNSPECIFIED' as const }] }, valid.teams[1]!] })).toContain('參賽隊伍 1 的球員位置都必須選擇。')
  })
})
