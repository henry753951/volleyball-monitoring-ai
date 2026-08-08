<script setup lang="ts">
import { Plus, Save, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { Match, RosterEditInput } from '~/lib/coreDomain'

const props = defineProps<{ open: boolean; match: Match }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const domain = useCoreDomain()
const activeTeamId = ref('')
const rowsByTeam = reactive<Record<string, Array<RosterEditInput & { rowKey: string }>>>({})
const pending = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
let rowSequence = 0

const activeTeam = computed(() => props.match.teams.find(team => team.id === activeTeamId.value) ?? props.match.teams[0])
const rows = computed(() => activeTeam.value ? (rowsByTeam[activeTeam.value.id] ?? []) : [])

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

watch(() => [props.open, props.match.id] as const, ([open]) => {
  if (!open) return
  error.value = null
  saved.value = false
  hydrate(props.match)
}, { immediate: true })

function addPlayer() {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id] ??= []
  rowsByTeam[activeTeam.value.id]!.push(newRow())
  saved.value = false
}

function removePlayer(index: number) {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id]?.splice(index, 1)
  saved.value = false
}

async function save() {
  const team = activeTeam.value
  if (!team || pending.value) return
  const roster = rows.value.map(({ rowKey: _rowKey, ...row }) => ({
    ...(row.id ? { id: row.id } : {}),
    jerseyNumber: row.jerseyNumber.trim(),
    name: row.name.trim(),
  }))
  if (roster.some(row => !row.name || !row.jerseyNumber)) {
    error.value = '請填寫球員姓名與背號。'
    return
  }
  pending.value = true
  error.value = null
  saved.value = false
  try {
    const updated = await domain.updateMatchRoster({ matchId: props.match.id, roster, teamId: team.id })
    hydrate(updated)
    saved.value = true
    emit('changed')
    toast.success('球員名單已儲存')
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法儲存名單'
    toast.error(error.value)
  }
  finally { pending.value = false }
}
</script>

<template>
  <UiAnimatedModal :open="open" title="球員名單" :description="match.title" @close="emit('close')">
    <div class="roster-dialog">
        <nav aria-label="選擇隊伍">
          <button v-for="team in match.teams" :key="team.id" type="button" :class="{ active: team.id === activeTeam?.id }" @click="activeTeamId = team.id; error = null; saved = false">
            <b>{{ team.shortName }}</b><span>{{ team.name }}</span>
          </button>
        </nav>

        <UiScrollArea class="roster-table">
          <div class="roster-table__inner">
            <div class="roster-table__head"><span>背號</span><span>球員</span><span /></div>
            <div v-for="(row, index) in rows" :key="row.rowKey" class="roster-row">
              <input v-model="row.jerseyNumber" :aria-label="`第 ${index + 1} 位球員背號`" maxlength="12" placeholder="00" @input="saved = false" />
              <input v-model="row.name" :aria-label="`第 ${index + 1} 位球員姓名`" maxlength="120" placeholder="球員姓名" @input="saved = false" />
              <button type="button" :aria-label="`移除 ${row.name || `第 ${index + 1} 位球員`}`" @click="removePlayer(index)"><Trash2 :size="15" /></button>
            </div>
            <button class="add" type="button" @click="addPlayer"><Plus :size="15" />新增球員</button>
          </div>
        </UiScrollArea>
    </div>
    <template #footer>
      <span v-if="error" class="error" role="alert">{{ error }}</span><span v-else-if="saved" class="saved">已儲存</span><span class="footer-spacer" />
      <button type="button" class="save" :disabled="pending" @click="save"><Save :size="15" />{{ pending ? '儲存中…' : '儲存名單' }}</button>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.roster-dialog{min-height:0;background:#11151a;color:#edf2f6}.roster-dialog nav{display:flex;gap:7px;padding:12px 14px 0}.roster-dialog nav button{min-width:0;flex:1;display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid #343c45;border-radius:10px;background:#181d23;color:#8f9aa5;text-align:left}.roster-dialog nav button.active{border-color:#3d79a8;background:#182d3d;color:#b9ddfa;box-shadow:0 0 0 1px #4c94c666 inset}.roster-dialog nav b{font-size:.75rem}.roster-dialog nav span{overflow:hidden;font-size:.66rem;text-overflow:ellipsis;white-space:nowrap}.roster-table{height:min(430px,calc(86dvh - 180px));margin-top:10px}.roster-table__inner{padding:0 14px 16px}.roster-table__head,.roster-row{display:grid;grid-template-columns:82px minmax(0,1fr) 34px;align-items:center;gap:7px}.roster-table__head{height:26px;padding:0 7px;color:#77828d;font-size:.61rem;font-weight:700}.roster-row{margin-bottom:6px}.roster-row input{width:100%;height:36px;padding:0 10px;border:1px solid #343c45;border-radius:8px;outline:0;background:#181d23;color:#eef2f5;font-size:.72rem}.roster-row input:focus{border-color:#4b91c6;box-shadow:0 0 0 3px #318bc722}.roster-row button{width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#8e98a2}.roster-row button:hover{background:#432226;color:#ffabb1}.add{height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px dashed #46515c;border-radius:8px;background:transparent;color:#a5afb9;font-size:.68rem;font-weight:700}.error{margin-right:auto;color:#ff9ca3;font-size:.68rem}.saved{margin-right:auto;color:#70d99e;font-size:.68rem}.footer-spacer{flex:1}.save{height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:1px solid #2782c4;border-radius:9px;background:#12659f;color:#fff;font-size:.69rem;font-weight:750}.save:disabled{opacity:.55}@media(max-width:560px){.roster-dialog nav span{display:none}}
</style>
