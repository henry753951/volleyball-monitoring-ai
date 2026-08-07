<script setup lang="ts">
import { CircleAlert, Link2, RefreshCw, UserRound } from 'lucide-vue-next'
import { createCoachDomainClient, type CoachMatchAnalytics } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const analytics = shallowRef<CoachMatchAnalytics | null>(null)
const pending = ref(true)
const error = shallowRef<Error | null>(null)
const saving = ref<string | null>(null)
const selections = reactive<Record<string, string>>({})
const client = createCoachDomainClient(createGraphQLTransport('/graphql'))

async function load() {
  try { analytics.value = await client.analytics(matchId.value); error.value = null }
  catch (cause) { error.value = cause instanceof Error ? cause : new Error('無法載入球員 identity') }
  finally { pending.value = false }
}
async function assign(runId: string, trackId: number) {
  const key = `${runId}:${trackId}`
  const rosterEntryId = selections[key]
  if (!rosterEntryId) return
  saving.value = key
  try { await client.assignTrackIdentity({ analysisRunId: runId, trackId, rosterEntryId }); await load() }
  catch (cause) { error.value = cause instanceof Error ? cause : new Error('Identity mapping 儲存失敗') }
  finally { saving.value = null }
}
onMounted(load)
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3"><div><p class="text-sm text-stone-500">{{ analytics?.match.title || `Match ${matchId}` }}</p><h1 class="text-2xl font-semibold tracking-tight">球員與 Track identity</h1><p class="mt-1 max-w-3xl text-sm text-stone-600">Track ID 只在單一 AnalysisRun 內有效；未綁 roster 前保持 Track 標示，不冒充背號或球員。</p></div><button class="button-secondary inline-flex items-center gap-2" @click="load"><RefreshCw class="size-4" />同步</button></header>
    <div v-if="pending" class="h-48 animate-pulse rounded-2xl bg-stone-200" aria-busy="true" />
    <div v-else-if="error && !analytics" class="rounded-2xl bg-rose-50 p-6 text-rose-900" role="alert"><p class="flex items-center gap-2 font-semibold"><CircleAlert class="size-5" />無法載入 identity</p><p class="mt-2 text-sm">{{ error.message }}</p></div>
    <template v-else-if="analytics">
      <div v-if="error" class="rounded-xl bg-rose-50 p-4 text-sm text-rose-900" role="alert">{{ error.message }}</div>
      <section class="overflow-hidden rounded-2xl bg-white shadow-sm" aria-labelledby="roster-heading"><div class="border-b border-stone-100 px-5 py-4"><h2 id="roster-heading" class="flex items-center gap-2 font-semibold"><UserRound class="size-5" />Roster evidence</h2></div><div class="grid sm:grid-cols-2 lg:grid-cols-3"><article v-for="player in analytics.players" :key="player.roster_entry_id" class="border-b border-stone-100 p-5 sm:border-r"><p class="text-sm text-stone-500">#{{ player.jersey_number }}</p><p class="mt-1 font-semibold">{{ player.name }}</p><p class="mt-3 text-sm text-stone-600">{{ player.contact_count }} contacts · sample {{ player.sample_count }}</p></article><p v-if="!analytics.players.length" class="p-5 text-sm text-stone-500">這場比賽尚未建立 roster。</p></div></section>
      <section class="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="unassigned-heading"><div class="flex items-center justify-between gap-3"><div><h2 id="unassigned-heading" class="flex items-center gap-2 font-semibold"><Link2 class="size-5" />未綁定 tracks</h2><p class="mt-1 text-sm text-stone-600">手動選擇 match roster；這是 identity correction，不會改寫 AI track ID。</p></div><span class="rounded-full bg-stone-100 px-3 py-1 text-sm font-semibold text-stone-900">{{ analytics.unassigned_tracks.length }}</span></div><div v-if="analytics.unassigned_tracks.length" class="mt-4 divide-y divide-stone-100"><div v-for="track in analytics.unassigned_tracks" :key="`${track.analysis_run_id}:${track.track_id}`" class="grid gap-3 py-4 md:grid-cols-[1fr_minmax(14rem,.8fr)_auto] md:items-center"><div><p class="font-semibold">Track {{ track.track_id }}</p><p class="text-sm text-stone-600">Set {{ track.set_number }} · Rally #{{ track.rally_ordinal }}</p></div><select v-model="selections[`${track.analysis_run_id}:${track.track_id}`]" class="field" :aria-label="`Track ${track.track_id} 對應球員`"><option value="">選擇 roster 球員</option><option v-for="player in analytics.players" :key="player.roster_entry_id" :value="player.roster_entry_id">#{{ player.jersey_number }} {{ player.name }}</option></select><button class="button-primary" :disabled="!selections[`${track.analysis_run_id}:${track.track_id}`] || saving === `${track.analysis_run_id}:${track.track_id}`" @click="assign(track.analysis_run_id, track.track_id)">{{ saving === `${track.analysis_run_id}:${track.track_id}` ? '儲存中…' : '確認綁定' }}</button></div></div><p v-else class="mt-4 text-sm text-emerald-700">目前沒有未綁定 track。</p></section>
    </template>
  </section>
</template>
