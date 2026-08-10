<script setup lang="ts">
import { Activity, Clock3, Film, Gauge, HardDrive, RadioTower, RotateCcw, TriangleAlert } from 'lucide-vue-next'
import type { MatchMediaSnapshot, StreamSnapshot } from '~/lib/operationsMonitor'

const props = defineProps<{
  matchTitle: string
  media: MatchMediaSnapshot | null
  open: boolean
  streams: readonly StreamSnapshot[]
}>()

defineEmits<{ close: [] }>()

const readyPercent = computed(() => props.media?.segmentCount
  ? Math.min(100, props.media.readySegmentCount / props.media.segmentCount * 100)
  : 0)

function sourceName(stream: StreamSnapshot) {
  return stream.sourceLabel?.trim() || stream.sourceKind.replaceAll('_', ' ')
}
function formatBytes(value: string | number) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1)
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
function formatDuration(value: string | undefined) {
  if (!value) return '0:00'
  const total = Number(BigInt(value) / 1_000_000n)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}
function fps(stream: StreamSnapshot) {
  const program = stream.program
  if (!program || !program.fps.denominator) return '—'
  return `${(program.fps.numerator / program.fps.denominator).toFixed(2)} fps`
}
function processingRate(stream: StreamSnapshot) {
  const started = stream.startedAt ? Date.parse(stream.startedAt) : Number.NaN
  const updated = Date.parse(stream.updatedAt)
  const mediaSeconds = Number(BigInt(stream.program?.indexedDurationUs ?? '0')) / 1_000_000
  const elapsedSeconds = (updated - started) / 1_000
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || mediaSeconds <= 0) return null
  return mediaSeconds / elapsedSeconds
}
function rateLabel(stream: StreamSnapshot) {
  const rate = processingRate(stream)
  return rate === null ? '—' : `${rate.toFixed(rate >= 10 ? 1 : 2)}×`
}
function updatedAt(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}
function statusLabel(stream: StreamSnapshot) {
  if (stream.status === 'LIVE') return '運行中'
  if (stream.status === 'FAILED') return '處理失敗'
  if (stream.program?.status === 'READY') return '索引完成'
  return stream.status.toLowerCase() === 'finished' ? '已完成' : stream.status
}
</script>

<template>
  <UiAnimatedModal :open="open" title="媒體與 DVR 監控" :description="matchTitle" width="wide" @close="$emit('close')">
    <UiScrollArea class="monitor-scroll">
      <div class="media-monitor">
        <section class="summary-strip">
          <div><Film :size="16" /><span><small>採集紀錄</small><strong>{{ streams.length }}</strong></span></div>
          <div><RadioTower :size="16" /><span><small>運行中</small><strong>{{ media?.activeCaptureCount ?? 0 }}</strong></span></div>
          <div><Activity :size="16" /><span><small>已索引</small><strong>{{ media?.readySegmentCount ?? 0 }} / {{ media?.segmentCount ?? 0 }}</strong></span></div>
          <div><HardDrive :size="16" /><span><small>媒體用量</small><strong>{{ formatBytes(media?.storedBytes ?? '0') }}</strong></span></div>
          <div :class="{ danger: media?.gapSegmentCount }"><TriangleAlert :size="16" /><span><small>時間軸中斷</small><strong>{{ media?.gapSegmentCount ?? 0 }}</strong></span></div>
        </section>

        <div class="index-progress" aria-label="整體 DVR 索引進度">
          <span><i :style="{ width: `${readyPercent}%` }" /></span>
          <small>{{ readyPercent.toFixed(1) }}%</small>
        </div>

        <section class="stream-section">
          <header><div><h3>來源歷程</h3><p>每場同時只使用一個來源；這裡保留更換與重新啟動的採集紀錄</p></div><span>更新於伺服器快照</span></header>
          <div v-if="streams.length" class="stream-list">
            <article v-for="stream in streams" :key="stream.captureSessionId">
              <div class="stream-title">
                <span class="source-icon"><RadioTower :size="16" /></span>
                <div><strong>{{ sourceName(stream) }}</strong><small>{{ stream.sourceKind.replaceAll('_', ' ') }} · {{ statusLabel(stream) }}</small></div>
                <span class="health" :class="stream.health.toLowerCase()"><i />{{ stream.health === 'HEALTHY' ? '正常' : stream.health }}</span>
              </div>
              <dl>
                <div><dt><Gauge :size="13" />處理倍率</dt><dd>{{ rateLabel(stream) }}</dd></div>
                <div><dt><Activity :size="13" />影格率</dt><dd>{{ fps(stream) }}</dd></div>
                <div><dt><Clock3 :size="13" />已索引時長</dt><dd>{{ formatDuration(stream.program?.indexedDurationUs) }}</dd></div>
                <div><dt><RotateCcw :size="13" />時間軸 Epoch</dt><dd>{{ stream.epochCount }}</dd></div>
              </dl>
              <div class="stream-detail">
                <span>片段 <b>{{ stream.program?.readySegmentCount ?? 0 }} / {{ stream.program?.segmentCount ?? 0 }}</b></span>
                <span>Gap <b :class="{ danger: stream.program?.gapSegmentCount }">{{ stream.program?.gapSegmentCount ?? 0 }}</b></span>
                <span>Playlist rev <b>{{ stream.program?.playlistRevision ?? '—' }}</b></span>
                <span>Time base <b>{{ stream.program ? `${stream.program.timeBase.numerator}/${stream.program.timeBase.denominator}` : '—' }}</b></span>
                <span>最後更新 <b>{{ updatedAt(stream.updatedAt) }}</b></span>
              </div>
            </article>
          </div>
          <div v-else class="empty-monitor"><Film :size="20" /><strong>尚未設定影音來源</strong><span>請先從場次操作加入 YouTube、直播或本機影片</span></div>
        </section>
      </div>
    </UiScrollArea>
  </UiAnimatedModal>
</template>

<style scoped>
.monitor-scroll{height:min(720px,calc(86dvh - 54px))}.media-monitor{display:grid;gap:18px;padding:18px}.summary-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;overflow:hidden;border-radius:10px;background:#24262a}.summary-strip>div{min-height:64px;display:flex;align-items:center;gap:10px;padding:0 13px;background:#131519;color:#8f9399}.summary-strip span{display:grid;gap:4px}.summary-strip small{color:#74777d;font-size:.51rem}.summary-strip strong{color:#f0f1f2;font-size:.7rem;font-variant-numeric:tabular-nums}.summary-strip .danger svg,.summary-strip .danger strong,.stream-detail b.danger{color:#df7b77}.index-progress{display:grid;grid-template-columns:minmax(0,1fr) 48px;align-items:center;gap:12px}.index-progress>span{height:6px;overflow:hidden;border-radius:3px;background:#292c31}.index-progress i{display:block;height:100%;background:#54c994}.index-progress small{color:#8b8f95;font-size:.52rem;font-variant-numeric:tabular-nums}.stream-section{overflow:hidden;border-radius:12px;background:#101114}.stream-section>header{min-height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 16px}.stream-section h3{margin:0;font-size:.68rem}.stream-section p{margin:4px 0 0;color:#767a80;font-size:.52rem}.stream-section>header>span{color:#70747a;font-size:.49rem}.stream-list{display:grid}.stream-list article{display:grid;gap:13px;padding:15px 16px;border-top:1px solid #202226}.stream-title{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:10px}.source-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:8px;background:#202227;color:#c9ccd0}.stream-title>div{display:grid;gap:3px}.stream-title strong{font-size:.62rem}.stream-title small{color:#767a80;font-size:.5rem}.health{display:flex;align-items:center;gap:6px;color:#9a9da3;font-size:.51rem}.health i{width:6px;height:6px;border-radius:50%;background:#4ac287}.health.degraded i,.health.offline i{background:#d4a255}.health.failed i{background:#df706d}.stream-list dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding-left:44px}.stream-list dl>div{display:grid;gap:5px}.stream-list dt{display:flex;align-items:center;gap:6px;color:#74787e;font-size:.5rem}.stream-list dd{margin:0;color:#dfe1e4;font-size:.64rem;font-weight:700;font-variant-numeric:tabular-nums}.stream-detail{display:flex;flex-wrap:wrap;gap:7px 18px;padding-left:44px;color:#71757b;font-size:.49rem}.stream-detail b{color:#aeb1b6;font-weight:650;font-variant-numeric:tabular-nums}.empty-monitor{min-height:180px;display:grid;place-items:center;align-content:center;gap:7px;color:#73777d}.empty-monitor strong{color:#aeb1b6;font-size:.62rem}.empty-monitor span{font-size:.51rem}
@media(max-width:760px){.summary-strip{grid-template-columns:repeat(2,1fr)}.summary-strip>div:last-child{grid-column:1/-1}.stream-list dl{grid-template-columns:repeat(2,1fr);gap:12px}.stream-detail,.stream-list dl{padding-left:0}}
</style>
