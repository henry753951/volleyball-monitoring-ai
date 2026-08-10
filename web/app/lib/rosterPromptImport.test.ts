import { describe, expect, it } from 'vitest'
import type { Match } from './coreDomain'
import type { RosterImportPayload } from './rosterPromptImport'
import { buildRosterResearchPrompt, parseRosterImportPaste, ROSTER_IMPORT_SCHEMA } from './rosterPromptImport'

const match = {
  id: '51278d81-5ec7-4a74-a399-ba4f53ca8758',
  title: "Chinese Taipei vs Puerto Rico · Girls' U17 2026",
  venue: 'Santiago, Chile',
  scheduledAt: '2026-08-09T02:00:00.000Z',
  teams: [
    { id: 'team-tpe', name: 'Chinese Taipei', shortName: 'TPE' },
    { id: 'team-pur', name: 'Puerto Rico', shortName: 'PUR' },
  ],
} satisfies Pick<Match, 'id' | 'scheduledAt' | 'teams' | 'title' | 'venue'>

function payload(): RosterImportPayload {
  return {
    schema: ROSTER_IMPORT_SCHEMA,
    matchId: match.id,
    teams: [
      { teamId: 'team-tpe', teamName: 'Chinese Taipei', players: [{ jerseyNumber: '7', name: 'Lin Player', position: 'OH' }] },
      { teamId: 'team-pur', teamName: 'Puerto Rico', players: [{ jerseyNumber: '12', name: 'Ana Player', position: 'L' }] },
    ],
  }
}

describe('roster research prompt import', () => {
  it('pins the current match and team identifiers into a JSON-only research prompt', () => {
    const prompt = buildRosterResearchPrompt(match)
    expect(prompt).toContain(ROSTER_IMPORT_SCHEMA)
    expect(prompt).toContain(match.id)
    expect(prompt).toContain('team-tpe')
    expect(prompt).toContain('team-pur')
    expect(prompt).toContain('只回傳一個 JSON object')
    expect(prompt).toContain('OH 主攻')
    expect(prompt).toContain('L 自由球員')
  })

  it('accepts both raw JSON and a single JSON code fence', () => {
    const raw = JSON.stringify(payload())
    expect(parseRosterImportPaste(raw, match)).toEqual({ ok: true, value: payload() })
    expect(parseRosterImportPaste(`\`\`\`json\n${raw}\n\`\`\``, match)).toEqual({ ok: true, value: payload() })
  })

  it('rejects a roster for another match or an incomplete pair of teams', () => {
    expect(parseRosterImportPaste(JSON.stringify({ ...payload(), matchId: 'another-match' }), match)).toMatchObject({ ok: false })
    expect(parseRosterImportPaste(JSON.stringify({ ...payload(), teams: payload().teams.slice(0, 1) }), match)).toMatchObject({ ok: false })
  })

  it('rejects empty, duplicate, or structurally extended player rows', () => {
    const empty = payload()
    empty.teams[0]!.players = []
    expect(parseRosterImportPaste(JSON.stringify(empty), match)).toMatchObject({ ok: false })

    const duplicate = payload()
    duplicate.teams[0]!.players.push({ jerseyNumber: '7', name: 'Another Player', position: 'MB' })
    expect(parseRosterImportPaste(JSON.stringify(duplicate), match)).toMatchObject({ ok: false })

    const extended = payload() as unknown as { teams: Array<{ players: Array<Record<string, string>> }> }
    extended.teams[0]!.players[0]!.country = 'TW'
    expect(parseRosterImportPaste(JSON.stringify(extended), match)).toMatchObject({ ok: false })
  })

  it('rejects an unsupported or missing player position', () => {
    const unsupported = payload() as unknown as { teams: Array<{ players: Array<Record<string, string>> }> }
    unsupported.teams[0]!.players[0]!.position = 'setter'
    expect(parseRosterImportPaste(JSON.stringify(unsupported), match)).toMatchObject({ ok: false })

    const missing = payload() as unknown as { teams: Array<{ players: Array<Record<string, string>> }> }
    delete missing.teams[0]!.players[0]!.position
    expect(parseRosterImportPaste(JSON.stringify(missing), match)).toMatchObject({ ok: false })
  })

  it('leaves ordinary text paste recognizable as non-import content', () => {
    expect(parseRosterImportPaste('王小明', match)).toEqual({ ok: false, reason: '貼上的內容不是有效 JSON。' })
  })
})
