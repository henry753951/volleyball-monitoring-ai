import type { Match, RosterInput, RosterPosition } from './coreDomain'

export const ROSTER_IMPORT_SCHEMA = 'vollyai.roster-import.v2' as const

type RosterPromptMatch = Pick<Match, 'id' | 'scheduledAt' | 'teams' | 'title' | 'venue'>

export interface RosterImportTeam {
  teamId: string
  teamName: string
  players: RosterInput[]
}

export interface RosterImportPayload {
  schema: typeof ROSTER_IMPORT_SCHEMA
  matchId: string
  teams: RosterImportTeam[]
}

export type RosterImportParseResult =
  | { ok: true; value: RosterImportPayload }
  | { ok: false; reason: string }

const MAX_PLAYERS_PER_TEAM = 60
const TOP_LEVEL_KEYS = ['matchId', 'schema', 'teams']
const TEAM_KEYS = ['players', 'teamId', 'teamName']
const PLAYER_KEYS = ['jerseyNumber', 'name', 'position']
const ROSTER_POSITIONS = new Set<RosterPosition>(['OH', 'MB', 'OPP', 'S', 'L', 'DS'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function comparisonKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

function jsonCandidate(value: string) {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() ?? trimmed
}

function invalid(reason: string): RosterImportParseResult {
  return { ok: false, reason }
}

export function buildRosterResearchPrompt(match: RosterPromptMatch) {
  const payload = {
    schema: ROSTER_IMPORT_SCHEMA,
    matchId: match.id,
    teams: match.teams.map(team => ({
      teamId: team.id,
      teamName: team.name,
      players: [] as RosterInput[],
    })),
  }

  return [
    '你是一位嚴謹的排球賽事資料研究員。請調查下列比賽兩隊的正式參賽球員名單、球衣背號與登錄位置。',
    '',
    `比賽：${match.title}`,
    `場地：${match.venue ?? '未提供'}`,
    `預定時間：${match.scheduledAt ?? '未提供'}`,
    ...match.teams.map(team => `隊伍：${team.name}（${team.shortName}，teamId: ${team.id}）`),
    '',
    '研究規則：',
    '1. 優先使用賽事官方名單、協會或球隊官方資料，並交叉確認背號與姓名。',
    '2. 不要猜測；無法可靠確認的球員不要加入。姓名保留官方慣用拼寫，位置需以官方名單為準。',
    '3. 每隊至少回傳 1 位球員；同隊不得有重複姓名或重複背號。',
    '4. schema、matchId、teamId、teamName 必須原樣保留，不得翻譯或改寫。',
    '5. 只回傳一個 JSON object，不要 Markdown code fence、來源說明、註解或其他文字。',
    '',
    '固定 JSON 格式如下；請只填入各隊 players：',
    JSON.stringify(payload, null, 2),
    '',
    '每位球員格式必須是：{"jerseyNumber":"字串","name":"字串","position":"OH|MB|OPP|S|L|DS"}',
    '位置代碼：OH 主攻、MB 副攻、OPP 舉對（接應）、S 舉球員、L 自由球員、DS 防守專家。',
  ].join('\n')
}

export function parseRosterImportPaste(
  value: string,
  match: RosterPromptMatch,
): RosterImportParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonCandidate(value))
  } catch {
    return invalid('貼上的內容不是有效 JSON。')
  }

  if (!isRecord(parsed) || !hasOnlyKeys(parsed, TOP_LEVEL_KEYS)) {
    return invalid('JSON 頂層格式不符合球員名單匯入格式。')
  }
  if (
    parsed.schema !== ROSTER_IMPORT_SCHEMA ||
    parsed.matchId !== match.id ||
    !Array.isArray(parsed.teams)
  ) {
    return invalid('JSON schema 或比賽識別碼不符合目前場次。')
  }
  if (parsed.teams.length !== match.teams.length) {
    return invalid('JSON 必須完整包含目前場次的兩隊名單。')
  }

  const expectedTeams = new Map(match.teams.map(team => [team.id, team]))
  const seenTeams = new Set<string>()
  const teams: RosterImportTeam[] = []

  for (const rawTeam of parsed.teams) {
    if (!isRecord(rawTeam) || !hasOnlyKeys(rawTeam, TEAM_KEYS))
      return invalid('隊伍資料欄位不符合固定格式。')
    if (
      typeof rawTeam.teamId !== 'string' ||
      typeof rawTeam.teamName !== 'string' ||
      !Array.isArray(rawTeam.players)
    ) {
      return invalid('隊伍識別碼、名稱或 players 格式不正確。')
    }

    const expected = expectedTeams.get(rawTeam.teamId)
    if (!expected || expected.name !== rawTeam.teamName || seenTeams.has(rawTeam.teamId)) {
      return invalid('JSON 的隊伍與目前場次不一致。')
    }
    if (!rawTeam.players.length || rawTeam.players.length > MAX_PLAYERS_PER_TEAM) {
      return invalid(`「${expected.shortName}」必須包含 1 到 ${MAX_PLAYERS_PER_TEAM} 位球員。`)
    }

    const names = new Set<string>()
    const jerseyNumbers = new Set<string>()
    const players: RosterInput[] = []
    for (const rawPlayer of rawTeam.players) {
      if (!isRecord(rawPlayer) || !hasOnlyKeys(rawPlayer, PLAYER_KEYS))
        return invalid('球員資料只能包含 jerseyNumber、name 與 position。')
      if (
        typeof rawPlayer.jerseyNumber !== 'string' ||
        typeof rawPlayer.name !== 'string' ||
        typeof rawPlayer.position !== 'string'
      )
        return invalid('球員背號、姓名與位置必須是字串。')

      const jerseyNumber = rawPlayer.jerseyNumber.trim()
      const name = rawPlayer.name.trim()
      const position = rawPlayer.position.trim().toUpperCase() as RosterPosition
      if (!jerseyNumber || jerseyNumber.length > 12 || !name || name.length > 120) {
        return invalid('球員姓名或背號為空，或超過欄位長度限制。')
      }
      if (!ROSTER_POSITIONS.has(position))
        return invalid('球員位置必須是 OH、MB、OPP、S、L 或 DS。')

      const nameKey = comparisonKey(name)
      const jerseyKey = comparisonKey(jerseyNumber)
      if (names.has(nameKey) || jerseyNumbers.has(jerseyKey)) {
        return invalid(`「${expected.shortName}」有重複姓名或背號。`)
      }
      names.add(nameKey)
      jerseyNumbers.add(jerseyKey)
      players.push({ jerseyNumber, name, position })
    }

    seenTeams.add(rawTeam.teamId)
    teams.push({ teamId: rawTeam.teamId, teamName: rawTeam.teamName, players })
  }

  if (seenTeams.size !== expectedTeams.size) return invalid('JSON 未完整包含目前場次的所有隊伍。')
  return { ok: true, value: { schema: ROSTER_IMPORT_SCHEMA, matchId: match.id, teams } }
}
