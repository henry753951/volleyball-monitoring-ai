<script setup lang="ts">
import { Plus, RadioTower, Search, SquarePen, UsersRound } from 'lucide-vue-next'
import type { CreateMatchSetupInput, Match } from '~/lib/coreDomain'

definePageMeta({ layout: 'control' })
const route = useRoute()
const router = useRouter()
const matchesState = useMatches()
type MatchListItem = (typeof matchesState.matches.value)[number]
const setup = useCreateMatchSetup()
const core = useCoreDomain()
const search = ref('')
const createOpen = ref(false)
const sourceMatch = shallowRef<Match | null>(null)
const rosterMatch = shallowRef<Match | null>(null)
const sourceDialogOpen = ref(false)
const rosterDialogOpen = ref(false)
const filteredMatches = computed(() => {
  const value = search.value.trim().toLocaleLowerCase()
  if (!value) return matchesState.matches.value
  return matchesState.matches.value.filter(match => [match.title, match.venue, ...match.teams.flatMap(team => [team.name, team.shortName])].some(item => item?.toLocaleLowerCase().includes(value)))
})

function currentSet(match: MatchListItem) { return match.sets.find(set => set.status.toLowerCase() === 'live') ?? match.sets.at(-1) }
async function openSource(matchId: string) {
  sourceMatch.value = await core.match(matchId)
  sourceDialogOpen.value = true
}
async function openRoster(matchId: string) {
  rosterMatch.value = await core.match(matchId)
  rosterDialogOpen.value = true
}
function closeRoster() {
  rosterDialogOpen.value = false
  if (route.query.match) void router.replace({ path: '/control' })
}
async function submit(input: CreateMatchSetupInput) {
  try {
    await setup.create(input)
    createOpen.value = false
    await matchesState.refresh()
  }
  catch { /* Stable error stays in MatchSetupForm. */ }
}
onMounted(async () => {
  await matchesState.refresh()
  const requestedMatch = typeof route.query.match === 'string' ? route.query.match : null
  if (requestedMatch) await openRoster(requestedMatch)
})
</script>

<template>
  <section class="control-page">
    <div class="control-actions">
      <label><Search :size="16" /><input v-model="search" placeholder="搜尋場次或隊伍" /></label>
      <button type="button" class="control-actions__create" @click="createOpen = true"><Plus :size="16" />新增場次</button>
    </div>

    <div class="match-table">
      <div class="match-table__head"><span>場次</span><span>隊伍</span><span>比分</span><span>狀態</span><span /></div>
      <div v-if="matchesState.pending.value" class="match-table__loading" />
      <div v-else-if="!filteredMatches.length" class="match-table__empty">沒有符合的場次</div>
      <article v-for="match in filteredMatches" :key="match.id">
        <div><NuxtLink :to="`/annotate/${match.id}`"><strong>{{ match.title }}</strong></NuxtLink><span>{{ match.venue || '—' }}</span></div>
        <div class="match-table__teams"><span>{{ match.teams[0]?.shortName || match.teams[0]?.name }}</span><i>vs</i><span>{{ match.teams[1]?.shortName || match.teams[1]?.name }}</span></div>
        <div class="match-table__score"><b>{{ currentSet(match)?.leftScore ?? 0 }}</b><i>:</i><b>{{ currentSet(match)?.rightScore ?? 0 }}</b></div>
        <span class="match-table__status" :class="{ live: match.status.toLowerCase() === 'live' }">{{ match.status.toLowerCase() === 'live' ? '進行中' : match.status.toLowerCase() === 'finished' ? '已結束' : '待開始' }}</span>
        <div class="match-table__buttons">
          <button type="button" title="影音來源" aria-label="影音來源" @click="openSource(match.id)"><RadioTower :size="16" /></button>
          <button type="button" title="球員名單" aria-label="球員名單" @click="openRoster(match.id)"><UsersRound :size="16" /></button>
          <NuxtLink :to="`/annotate/${match.id}`" title="開啟標記工作站"><SquarePen :size="16" /><span>標記</span></NuxtLink>
        </div>
      </article>
    </div>

    <UiAnimatedModal :open="createOpen" title="新增場次" description="建立場次、隊伍與初始球員名單" width="wide" @close="createOpen = false">
      <UiScrollArea class="create-scroll">
        <div class="create-content">
          <MatchSetupForm :pending="setup.pending.value" :error="setup.error.value" compact @submit="submit" @cancel="createOpen = false" />
        </div>
      </UiScrollArea>
    </UiAnimatedModal>

    <LazyCaptureControlDialog v-if="sourceMatch" :open="sourceDialogOpen" :match-id="sourceMatch.id" :captures="sourceMatch.captureSessions ?? []" @close="sourceDialogOpen = false" @changed="matchesState.refresh" />
    <LazyRosterEditorDialog v-if="rosterMatch" :open="rosterDialogOpen" :match="rosterMatch" @close="closeRoster" @changed="matchesState.refresh" />
  </section>
</template>

<style scoped>
.control-page{width:min(100%,1320px);margin:0 auto}.control-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.control-actions label{width:min(360px,50vw);min-height:38px;display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid #303942;border-radius:10px;background:#14191f;color:#7f8a95}.control-actions input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:#eef2f5;font-size:.74rem}.control-actions__create{min-height:38px;display:inline-flex;align-items:center;gap:7px;padding:0 13px;border:1px solid #2a83c4;border-radius:10px;background:#12659f;color:#fff;font-size:.74rem;font-weight:700}.match-table{overflow:hidden;border:1px solid #29313a;border-radius:14px;background:#11161b;box-shadow:0 18px 50px #0004}.match-table__head,.match-table article{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(190px,.8fr) 130px 100px 200px;align-items:center;gap:14px;padding:0 16px}.match-table__head{height:38px;background:#151a20;color:#77828d;font-size:.65rem;font-weight:700}.match-table article{min-height:66px;border-top:1px solid #252c33}.match-table article:hover{background:#151b21}.match-table article>div:first-child{min-width:0;display:grid;gap:3px}.match-table article>div:first-child>a{min-width:0;color:inherit;text-decoration:none}.match-table article>div:first-child strong{display:block;overflow:hidden;font-size:.76rem;text-overflow:ellipsis;white-space:nowrap}.match-table article>div:first-child span{color:#7e8994;font-size:.64rem}.match-table__teams{display:flex;align-items:center;gap:8px;font-size:.72rem;font-weight:650}.match-table__teams i,.match-table__score i{color:#69737d;font-size:.62rem;font-style:normal}.match-table__score{display:flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums}.match-table__score b{font-size:1.15rem}.match-table__status{display:inline-flex;width:max-content;align-items:center;gap:5px;color:#8c96a0;font-size:.68rem}.match-table__status::before{width:7px;height:7px;border-radius:50%;background:#65717c;content:""}.match-table__status.live{color:#72dba0}.match-table__status.live::before{background:#2fc67c}.match-table__buttons{display:flex;justify-content:flex-end;gap:6px}.match-table__buttons button,.match-table__buttons a{min-height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:1px solid #343d46;border-radius:9px;background:#181d23;color:#c4ccd3;font-size:.68rem;font-weight:700;text-decoration:none}.match-table__buttons button{width:34px;padding:0}.match-table__buttons button:hover,.match-table__buttons a:hover{border-color:#52606c;background:#20272e;color:#fff}.match-table__loading{height:320px;background:linear-gradient(100deg,#13181e 20%,#20272e 40%,#13181e 60%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}.match-table__empty{min-height:180px;display:grid;place-items:center;color:#7a858f;font-size:.74rem}.create-scroll{height:min(720px,calc(86dvh - 52px))}.create-content{padding:14px}@keyframes shimmer{to{background-position:-200% 0}}@media(max-width:920px){.match-table__head{display:none}.match-table article{grid-template-columns:minmax(0,1fr) auto auto;gap:10px;padding:12px 14px}.match-table__teams{grid-column:1}.match-table__score{grid-column:2}.match-table__status{grid-column:3}.match-table__buttons{grid-column:1/-1;justify-content:flex-start}}@media(prefers-reduced-motion:reduce){.match-table__loading{animation:none}}
</style>
