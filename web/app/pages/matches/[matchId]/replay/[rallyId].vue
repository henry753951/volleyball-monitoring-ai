<script setup lang="ts">
import { ArrowLeft, CircleAlert, Cpu, Gauge, Route as RouteIcon } from 'lucide-vue-next'
import { createCoachDomainClient, type CoachRallyReplay, type ReplayContactEvent } from '~/lib/coachDomain'
import { createGraphQLTransport } from '~/lib/coreDomain'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const rallyId = computed(() => String(route.params.rallyId))
const replay = shallowRef<CoachRallyReplay | null>(null)
const pending = ref(true)
const error = shallowRef<Error | null>(null)
const video = useTemplateRef<HTMLVideoElement>('video')
const currentFrame = ref(0)
const videoWidth = ref(0)
const videoHeight = ref(0)

onMounted(async () => {
  try { replay.value = await createCoachDomainClient(createGraphQLTransport('/graphql')).rallyReplay(rallyId.value) }
  catch (cause) { error.value = cause instanceof Error ? cause : new Error('無法載入 Rally replay') }
  finally { pending.value = false }
})

function updateVideoState() {
  const element = video.value
  const fps = replay.value?.clip?.fps
  if (!element || !fps) return
  videoWidth.value = element.videoWidth
  videoHeight.value = element.videoHeight
  currentFrame.value = Math.max(0, Math.floor(element.currentTime * fps.num / fps.den))
}
function seekTimeUs(value: string) {
  if (!video.value) return
  const microseconds = BigInt(value)
  if (microseconds < 0n || microseconds > 3_600_000_000n) return
  video.value.currentTime = Number(microseconds) / 1_000_000
  void video.value.play()
}
function seekFrame(value: string | null) {
  const fps = replay.value?.clip?.fps
  if (!value || !fps || !video.value) return
  const frame = BigInt(value)
  const microseconds = frame * BigInt(fps.den) * 1_000_000n / BigInt(fps.num)
  seekTimeUs(microseconds.toString())
}
function eventLabel(event: ReplayContactEvent) {
  if (event.is_terminal) return 'Terminal'
  return event.marker_kind === 'service' ? 'Service' : `Contact ${event.sequence_index}`
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div><NuxtLink :to="`/matches/${matchId}/history`" class="mb-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-teal-800"><ArrowLeft class="size-4" />返回紀錄</NuxtLink><h1 class="text-2xl font-semibold tracking-tight">Set {{ replay?.rally.set.number ?? '—' }} · Rally #{{ replay?.rally.ordinal ?? '—' }}</h1><p class="mt-1 text-sm text-stone-600">Immutable submission replay · revision {{ replay?.submission.annotation_revision ?? '—' }}</p></div>
      <span v-if="replay" class="rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800">{{ replay.rally.processing_status }}</span>
    </header>

    <div v-if="pending" class="min-h-72 animate-pulse rounded-2xl bg-stone-200" aria-busy="true" />
    <div v-else-if="error" class="rounded-2xl bg-rose-50 p-6 text-rose-900" role="alert"><p class="flex items-center gap-2 font-semibold"><CircleAlert class="size-5" />Replay 載入失敗</p><p class="mt-2 text-sm">{{ error.message }}</p></div>
    <div v-else-if="!replay" class="rounded-2xl bg-amber-50 p-6 text-amber-950">找不到已提交的 Rally，或你沒有查看權限。</div>
    <template v-else>
      <div class="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
        <section class="overflow-hidden rounded-2xl bg-stone-950 shadow-lg shadow-stone-950/15">
          <div v-if="replay.clip" class="relative aspect-video">
            <video ref="video" :src="replay.clip.url" controls playsinline preload="metadata" class="size-full object-contain" @loadedmetadata="updateVideoState" @timeupdate="updateVideoState" @seeked="updateVideoState" />
            <ReplayOverlayCanvas v-if="replay.analysis" :events="replay.analysis.contact_events" :frame="currentFrame" :video-width="videoWidth" :video-height="videoHeight" />
          </div>
          <div v-else class="grid aspect-video place-items-center px-6 text-center text-white/70">Canonical clip 尚未完成。</div>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3 text-sm text-white/70"><span>Frame {{ currentFrame }}</span><span>{{ replay.clip ? `${replay.clip.fps.num}/${replay.clip.fps.den} fps` : '等待 clip' }}</span></div>
        </section>

        <aside class="space-y-4">
          <section class="rounded-2xl bg-white p-5 shadow-sm"><h2 class="flex items-center gap-2 font-semibold"><Gauge class="size-5" />Rally outcome</h2><p class="mt-4 text-xl font-semibold">{{ replay.rally.outcome.scoring_team?.name || (replay.rally.outcome.score_resolution === 'unknown' ? '結果未知' : replay.rally.outcome.scoring_court_side) }}</p><p class="mt-1 text-sm text-stone-500">{{ replay.rally.left_team.shortName }} vs {{ replay.rally.right_team.shortName }}</p></section>
          <section class="rounded-2xl bg-white p-5 shadow-sm"><h2 class="flex items-center gap-2 font-semibold"><Cpu class="size-5" />Analysis</h2><template v-if="replay.analysis"><p class="mt-4 font-semibold">{{ replay.analysis.version }}</p><p class="mt-1 text-sm text-stone-500">{{ replay.analysis.producer.name }} · {{ replay.analysis.producer.build_id }}</p><div class="mt-4 grid grid-cols-3 gap-2 text-center"><div class="rounded-xl bg-stone-100 p-2"><strong>{{ replay.analysis.tracks.length }}</strong><span class="block text-xs text-stone-500">tracks</span></div><div class="rounded-xl bg-stone-100 p-2"><strong>{{ replay.analysis.contact_events.length }}</strong><span class="block text-xs text-stone-500">events</span></div><div class="rounded-xl bg-stone-100 p-2"><strong>{{ replay.analysis.paths.length }}</strong><span class="block text-xs text-stone-500">paths</span></div></div></template><p v-else class="mt-4 text-sm text-stone-500">分析尚未完成；green submission 不等於 AI 完成。</p></section>
        </aside>
      </div>

      <section class="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="events-heading">
        <h2 id="events-heading" class="font-semibold">Key points</h2>
        <div class="mt-4 flex gap-2 overflow-x-auto pb-1">
          <button v-for="event in replay.analysis?.contact_events ?? []" :key="event.key_point_id" type="button" class="button-secondary min-w-36 text-left" @click="seekTimeUs(event.anchor_time_us)"><span class="block font-semibold">{{ eventLabel(event) }}</span><span class="mt-1 block text-xs font-normal text-stone-500">frame {{ event.resolved_frame_index ?? event.anchor_frame_index }} · {{ event.association_state }}</span></button>
          <p v-if="!replay.analysis?.contact_events.length" class="text-sm text-stone-500">沒有可顯示的 analysis contact events。</p>
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-[.7fr_1.3fr]">
        <div><p class="flex items-center gap-2 font-semibold"><RouteIcon class="size-5" />2D court paths</p><p class="mt-2 max-w-prose text-sm text-stone-600">直接顯示外部 AI 的 canonical court_pos。場外負值或大於 1 的座標保留；中央與前端不投影、不 clamp。點球路可跳到對應影片 frame。</p></div>
        <CourtPathView :paths="replay.analysis?.paths ?? []" @seek="seekFrame" />
      </section>
    </template>
  </section>
</template>
