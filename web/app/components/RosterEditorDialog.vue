<script setup lang="ts">
import { Plus, Save, Trash2, UsersRound, X } from 'lucide-vue-next'
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
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法儲存名單'
  }
  finally { pending.value = false }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="roster-backdrop" @mousedown.self="emit('close')">
      <section class="roster-dialog" role="dialog" aria-modal="true" aria-labelledby="roster-title">
        <header>
          <div><UsersRound :size="17" /><strong id="roster-title">球員名單</strong><span>{{ match.title }}</span></div>
          <button type="button" aria-label="關閉" @click="emit('close')"><X :size="17" /></button>
        </header>

        <nav aria-label="選擇隊伍">
          <button v-for="team in match.teams" :key="team.id" type="button" :class="{ active: team.id === activeTeam?.id }" @click="activeTeamId = team.id; error = null; saved = false">
            <b>{{ team.shortName }}</b><span>{{ team.name }}</span>
          </button>
        </nav>

        <div class="roster-table">
          <div class="roster-table__head"><span>背號</span><span>球員</span><span /></div>
          <div v-for="(row, index) in rows" :key="row.rowKey" class="roster-row">
            <input v-model="row.jerseyNumber" :aria-label="`第 ${index + 1} 位球員背號`" maxlength="12" placeholder="00" @input="saved = false" />
            <input v-model="row.name" :aria-label="`第 ${index + 1} 位球員姓名`" maxlength="120" placeholder="球員姓名" @input="saved = false" />
            <button type="button" :aria-label="`移除 ${row.name || `第 ${index + 1} 位球員`}`" @click="removePlayer(index)"><Trash2 :size="15" /></button>
          </div>
          <button class="add" type="button" @click="addPlayer"><Plus :size="15" />新增球員</button>
        </div>

        <footer>
          <span v-if="error" class="error" role="alert">{{ error }}</span>
          <span v-else-if="saved" class="saved">已儲存</span>
          <span v-else />
          <button type="button" class="save" :disabled="pending" @click="save"><Save :size="15" />{{ pending ? '儲存中…' : '儲存名單' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.roster-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:#10151d73;backdrop-filter:blur(10px);font-family:"Segoe UI Variable Text",Aptos,"Segoe UI",sans-serif}.roster-dialog{width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:hidden;border:1px solid #d7dce2;border-radius:16px;background:#f7f8fa;color:#18212c;box-shadow:0 28px 90px #17203038}.roster-dialog>header{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid #dde1e6;background:#fff}.roster-dialog>header div{min-width:0;display:flex;align-items:center;gap:8px}.roster-dialog>header strong{font-size:.78rem}.roster-dialog>header span{overflow:hidden;color:#7c8590;font-size:.67rem;text-overflow:ellipsis;white-space:nowrap}.roster-dialog>header button,.roster-row button{width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#66707b}.roster-dialog nav{display:flex;gap:6px;padding:10px 12px 0}.roster-dialog nav button{min-width:0;flex:1;display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid #d9dee4;border-radius:10px;background:#fff;color:#6f7883;text-align:left}.roster-dialog nav button.active{border-color:#9dc5f5;background:#edf5ff;color:#075dbd;box-shadow:0 0 0 2px #d9eaff inset}.roster-dialog nav b{font-size:.75rem}.roster-dialog nav span{overflow:hidden;font-size:.66rem;text-overflow:ellipsis;white-space:nowrap}.roster-table{min-height:270px;max-height:calc(100dvh - 220px);overflow:auto;padding:10px 12px}.roster-table__head,.roster-row{display:grid;grid-template-columns:82px minmax(0,1fr) 34px;align-items:center;gap:7px}.roster-table__head{height:26px;padding:0 7px;color:#858d97;font-size:.61rem;font-weight:700}.roster-row{margin-bottom:6px}.roster-row input{width:100%;height:36px;padding:0 10px;border:1px solid #d8dde3;border-radius:8px;outline:0;background:#fff;color:#202934;font-size:.72rem}.roster-row input:focus{border-color:#72a8e8;box-shadow:0 0 0 3px #1876dc18}.roster-row button:hover{background:#feeaeb;color:#bd2632}.add{height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px dashed #c5ccd4;border-radius:8px;background:transparent;color:#576473;font-size:.68rem;font-weight:700}.roster-dialog footer{height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 13px;border-top:1px solid #dce1e6;background:#fff}.error{color:#bf2731;font-size:.68rem}.saved{color:#13734c;font-size:.68rem}.save{height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:0;border-radius:9px;background:#0868d7;color:#fff;font-size:.69rem;font-weight:750}.save:disabled{opacity:.55}@media(max-width:560px){.roster-dialog nav span{display:none}.roster-table{max-height:calc(100dvh - 205px)}}
</style>
