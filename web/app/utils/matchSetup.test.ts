import { describe, expect, it } from 'vitest'
import { validateMatchSetup } from './matchSetup'

const valid = {
  title: '決賽',
  leftTeam: { name: '北隊', shortName: 'N', roster: [{ name: '甲', jerseyNumber: '1', position: 'OH' as const }] },
  rightTeam: { name: '南隊', shortName: 'S', roster: [{ name: '乙', jerseyNumber: '1', position: 'L' as const }] },
}

describe('match setup validation', () => {
  it('accepts two complete teams', () => expect(validateMatchSetup(valid)).toEqual([]))
  it('rejects duplicate teams and jerseys within one team', () => {
    expect(validateMatchSetup({ ...valid, rightTeam: { ...valid.leftTeam, roster: [{ name: '乙', jerseyNumber: '1', position: 'MB' }, { name: '丙', jerseyNumber: '1', position: 'S' }] } })).toEqual(expect.arrayContaining(['左右隊伍名稱必須不同。', '左右隊伍簡稱必須不同。', '右側隊伍的背號不可重複。']))
  })
  it('requires every player position', () => {
    expect(validateMatchSetup({ ...valid, leftTeam: { ...valid.leftTeam, roster: [{ ...valid.leftTeam.roster[0]!, position: 'UNSPECIFIED' }] } })).toContain('左側隊伍的球員位置都必須選擇。')
  })
})
