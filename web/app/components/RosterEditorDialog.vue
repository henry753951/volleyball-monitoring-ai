<script setup lang="ts">
import { ClipboardCopy, Plus, Save, Sparkles, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import UiButton from '~/components/ui/Button.vue'
import type { Match, RosterEditInput } from '~/lib/coreDomain'
import { buildRosterResearchPrompt, parseRosterImportPaste } from '~/lib/rosterPromptImport'

const props = defineProps<{ open: boolean; match: Match }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const domain = useCoreDomain()
const activeTeamId = ref('')
const rowsByTeam = reactive<Record<string, Array<RosterEditInput & { rowKey: string }>>>({})
const pending = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
const importStatus = ref('')
const dirtyTeamIds = reactive(new Set<string>())
let rowSequence = 0

const activeTeam = computed(() => props.match.teams.find(team => team.id === activeTeamId.value) ?? props.match.teams[0])
const rows = computed(() => activeTeam.value ? (rowsByTeam[activeTeam.value.id] ?? []) : [])
const dirtyTeamCount = computed(() => dirtyTeamIds.size)
const saveLabel = computed(() => pending.value ? '儲存中…' : dirtyTeamCount.value > 1 ? '儲存兩隊名單' : '儲存名單')

function newRow(row: RosterEditInput = { jerseyNumber: '', name: '' }) {
  rowSequence += 1
  return { ...row, rowKey: row.id ?? `new-${rowSequence}` }
}

function hydrate(match: Match) {
  for (const team of match.teams) {
    rowsByTeam[team.id] = match.rosterEntries
      .filter(entry => entry.teamId === team.id)
      .map(entry => newRow({ id: entry.id, jerseyNumber: entry.jerseyNumber, name: entry.name }))
  }
  activeTeamId.value = match.teams.some(team => team.id === activeTeamId.value)
    ? activeTeamId.value
    : match.teams[0]?.id ?? ''
}

function hydrateTeam(match: Match, teamId: string) {
  rowsByTeam[teamId] = match.rosterEntries
    .filter(entry => entry.teamId === teamId)
    .map(entry => newRow({ id: entry.id, jerseyNumber: entry.jerseyNumber, name: entry.name }))
}

watch(() => [props.open, props.match.id] as const, ([open]) => {
  if (!open) return
  error.value = null
  saved.value = false
  importStatus.value = ''
  dirtyTeamIds.clear()
  hydrate(props.match)
}, { immediate: true })

function markTeamDirty(teamId: string) {
  dirtyTeamIds.add(teamId)
  saved.value = false
}

function markActiveTeamDirty() {
  if (activeTeam.value) markTeamDirty(activeTeam.value.id)
}

function addPlayer() {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id] ??= []
  rowsByTeam[activeTeam.value.id]!.push(newRow())
  markTeamDirty(activeTeam.value.id)
}

function removePlayer(index: number) {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id]?.splice(index, 1)
  markTeamDirty(activeTeam.value.id)
}

function rosterForTeam(teamId: string) {
  return (rowsByTeam[teamId] ?? []).map(({ rowKey: _rowKey, ...row }) => ({
    ...(row.id ? { id: row.id } : {}),
    jerseyNumber: row.jerseyNumber.trim(),
    name: row.name.trim(),
  }))
}

function validateRoster(teamId: string, roster: RosterEditInput[]) {
  const team = props.match.teams.find(item => item.id === teamId)
  const label = team?.shortName ?? '隊伍'
  if (!roster.length) return `${label} 至少需要一位球員。`
  if (roster.some(row => !row.name || !row.jerseyNumber)) return `請填寫 ${label} 所有球員的姓名與背號。`
  const names = new Set<string>()
  const jerseys = new Set<string>()
  for (const row of roster) {
    const name = row.name.normalize('NFKC').toLocaleLowerCase()
    const jersey = row.jerseyNumber.normalize('NFKC').toLocaleLowerCase()
    if (names.has(name) || jerseys.has(jersey)) return `${label} 有重複姓名或背號。`
    names.add(name)
    jerseys.add(jersey)
  }
  return null
}

function importRows(teamId: string, players: Array<{ jerseyNumber: string; name: string }>) {
  const available = [...(rowsByTeam[teamId] ?? [])]
  rowsByTeam[teamId] = players.map((player) => {
    const jerseyKey = player.jerseyNumber.normalize('NFKC').toLocaleLowerCase()
    const nameKey = player.name.normalize('NFKC').toLocaleLowerCase()
    const existingIndex = available.findIndex(row =>
      row.jerseyNumber.trim().normalize('NFKC').toLocaleLowerCase() === jerseyKey
      || row.name.trim().normalize('NFKC').toLocaleLowerCase() === nameKey,
    )
    const existing = existingIndex >= 0 ? available.splice(existingIndex, 1)[0] : undefined
    return newRow({ ...(existing?.id ? { id: existing.id } : {}), ...player })
  })
}

async function copyResearchPrompt() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('瀏覽器不支援剪貼簿寫入')
    await navigator.clipboard.writeText(buildRosterResearchPrompt(props.match))
    toast.success('調查 Prompt 已複製；交給 LLM 後，將回傳 JSON 貼回此視窗')
  }
  catch (cause) {
    toast.error(cause instanceof Error ? `無法複製 Prompt：${cause.message}` : '無法複製 Prompt')
  }
}

function handlePaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain')
  if (!text) return
  const result = parseRosterImportPaste(text, props.match)
  if (!result.ok) return

  event.preventDefault()
  for (const team of result.value.teams) {
    importRows(team.teamId, team.players)
    dirtyTeamIds.add(team.teamId)
  }
  error.value = null
  saved.value = false
  importStatus.value = result.value.teams
    .map(team => `${props.match.teams.find(item => item.id === team.teamId)?.shortName ?? team.teamName} ${team.players.length} 位`)
    .join('、')
  toast.success(`已匯入兩隊草稿：${importStatus.value}`)
}

async function save() {
  if (pending.value || !dirtyTeamIds.size) return
  const teams = props.match.teams.filter(team => dirtyTeamIds.has(team.id))
  const rosters = new Map(teams.map(team => [team.id, rosterForTeam(team.id)]))
  for (const team of teams) {
    const validationError = validateRoster(team.id, rosters.get(team.id) ?? [])
    if (validationError) {
      error.value = validationError
      return
    }
  }

  pending.value = true
  error.value = null
  saved.value = false
  const completed: string[] = []
  let currentTeam = teams[0]
  try {
    for (const team of teams) {
      currentTeam = team
      const updated = await domain.updateMatchRoster({ matchId: props.match.id, roster: rosters.get(team.id) ?? [], teamId: team.id })
      hydrateTeam(updated, team.id)
      dirtyTeamIds.delete(team.id)
      completed.push(team.shortName)
    }
    importStatus.value = ''
    saved.value = true
    emit('changed')
    toast.success(completed.length > 1 ? '兩隊球員名單已儲存' : '球員名單已儲存')
  }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : '無法儲存名單'
    error.value = completed.length
      ? `已儲存 ${completed.join('、')}；${currentTeam?.shortName ?? '其餘隊伍'} 儲存失敗：${reason}`
      : reason
    importStatus.value = dirtyTeamIds.size ? `尚有 ${dirtyTeamIds.size} 隊草稿未儲存` : ''
    if (completed.length) emit('changed')
    toast.error(error.value)
  }
  finally { pending.value = false }
}
</script>

<template>
  <UiAnimatedModal :open="open" title="球員名單" :description="match.title" @close="emit('close')">
    <div class="roster-dialog" @paste.capture="handlePaste">
        <div class="roster-import-bar">
          <span><Sparkles :size="15" /><strong>AI 名單匯入</strong><small>貼上相容 JSON 會填入兩隊草稿</small></span>
          <UiTooltip side="bottom" content="複製包含本場隊名、識別碼與固定 JSON 格式的調查指示。交給 LLM 查詢後，把回傳 JSON 直接貼回此視窗即可匯入兩隊草稿。">
            <UiButton variant="secondary" size="sm" aria-label="複製球員名單調查 Prompt" @click="copyResearchPrompt"><ClipboardCopy :size="14" />複製查詢 Prompt</UiButton>
          </UiTooltip>
        </div>
        <nav aria-label="選擇隊伍">
          <UiButton v-for="team in match.teams" :key="team.id" :variant="team.id === activeTeam?.id ? 'secondary' : 'ghost'" :class="{ active: team.id === activeTeam?.id }" @click="activeTeamId = team.id; error = null; saved = false">
            <b>{{ team.shortName }}</b><span>{{ team.name }}</span>
          </UiButton>
        </nav>

        <UiScrollArea class="roster-table">
          <div class="roster-table__inner">
            <div class="roster-table__head"><span>背號</span><span>球員</span><span /></div>
            <div v-for="(row, index) in rows" :key="row.rowKey" class="roster-row">
              <input v-model="row.jerseyNumber" :aria-label="`第 ${index + 1} 位球員背號`" maxlength="12" placeholder="00" @input="markActiveTeamDirty" />
              <input v-model="row.name" :aria-label="`第 ${index + 1} 位球員姓名`" maxlength="120" placeholder="球員姓名" @input="markActiveTeamDirty" />
              <UiButton variant="ghost" size="icon-sm" :aria-label="`移除 ${row.name || `第 ${index + 1} 位球員`}`" @click="removePlayer(index)"><Trash2 :size="15" /></UiButton>
            </div>
            <UiButton class="add" variant="ghost" size="sm" @click="addPlayer"><Plus :size="15" />新增球員</UiButton>
          </div>
        </UiScrollArea>
    </div>
    <template #footer>
      <span v-if="error" class="error" role="alert">{{ error }}</span><span v-else-if="importStatus" class="imported" role="status">已匯入 {{ importStatus }}，尚未儲存</span><span v-else-if="saved" class="saved">已儲存</span><span class="footer-spacer" />
      <UiButton :disabled="pending || !dirtyTeamCount" @click="save"><Save :size="15" />{{ saveLabel }}</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.roster-dialog{min-height:0;background:#09090b;color:#fafafa}.roster-import-bar{min-height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-bottom:1px solid #2f2f33;background:#18181b}.roster-import-bar>span{min-width:0;display:grid;grid-template-columns:auto auto;align-items:center;justify-content:start;gap:2px 7px}.roster-import-bar>span>svg{grid-row:1/3;color:#a1a1aa}.roster-import-bar strong{font-size:.69rem}.roster-import-bar small{grid-column:2;color:#a1a1aa;font-size:.6rem}.roster-import-bar :deep(button){flex:none}.roster-dialog nav{display:flex;gap:6px;padding:12px 14px 0}.roster-dialog nav :deep(button){min-width:0;flex:1;justify-content:flex-start;text-align:left}.roster-dialog nav :deep(button.active){background:#27272a;color:#fafafa}.roster-dialog nav b{font-size:.75rem}.roster-dialog nav span{overflow:hidden;color:#a1a1aa;font-size:.66rem;text-overflow:ellipsis;white-space:nowrap}.roster-table{height:min(430px,calc(86dvh - 232px));margin-top:10px}.roster-table__inner{padding:0 14px 16px}.roster-table__head,.roster-row{display:grid;grid-template-columns:82px minmax(0,1fr) 34px;align-items:center;gap:7px}.roster-table__head{height:26px;padding:0 7px;color:#71717a;font-size:.61rem;font-weight:700}.roster-row{margin-bottom:6px}.roster-row input{width:100%;height:36px;padding:0 10px;border:1px solid #27272a;border-radius:8px;outline:0;background:#18181b;color:#fafafa;font-size:.72rem}.roster-row input:focus{border-color:#71717a;box-shadow:0 0 0 2px #fafafa24}.roster-row :deep(button){color:#a1a1aa}.roster-row :deep(button:hover){background:#2b1114;color:#fca5a5}.add{margin-top:4px}.error{margin-right:auto;color:#fca5a5;font-size:.68rem}.imported,.saved{margin-right:auto;color:#86efac;font-size:.68rem}.footer-spacer{flex:1}@media(max-width:560px){.roster-import-bar{align-items:flex-start;flex-direction:column}.roster-import-bar :deep(button){width:100%}.roster-dialog nav span,.roster-import-bar small{display:none}.roster-table{height:min(400px,calc(86dvh - 240px))}}
</style>
