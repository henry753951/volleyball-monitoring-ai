<script setup lang="ts">
import { Square } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { createCoreDomainClient, createGraphQLTransport, type CaptureSession } from '~/lib/coreDomain'

const props = defineProps<{ open: boolean; matchId: string; captures: CaptureSession[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const domain = createCoreDomainClient(createGraphQLTransport('/graphql'))
const sourceKind = ref('rtmp')
const sourceLabel = ref('')
const ingestPath = ref('')
const secretRef = ref('')
const pending = ref(false)
const stoppingId = ref<string | null>(null)
const captureToStop = shallowRef<CaptureSession | null>(null)
const error = ref<string | null>(null)
const activeCaptures = computed(() => props.captures.filter(capture => ['STARTING', 'LIVE', 'STOPPING'].includes(capture.status.toUpperCase())))
function statusLabel(status: string) {
  if (status.toUpperCase() === 'LIVE') return '已連線'
  if (status.toUpperCase() === 'STARTING') return '連線中'
  if (status.toUpperCase() === 'STOPPING') return '停止中'
  return '已停止'
}
function healthLabel(health: string) {
  if (health.toUpperCase() === 'HEALTHY') return '訊號正常'
  if (health.toUpperCase() === 'DEGRADED') return '訊號不穩'
  if (health.toUpperCase() === 'STARTING') return '偵測中'
  return '無訊號'
}
const publishHint = computed(() => {
  const path = ingestPath.value.trim() || '<ingest-path>'
  const host = typeof window === 'undefined' ? 'server' : window.location.hostname
  if (sourceKind.value === 'srt') return `srt://${host}:8890?streamid=publish:${path}`
  if (sourceKind.value === 'rtsp') return `rtsp://${host}:8554/${path}`
  return `rtmp://${host}:1935/${path}`
})

watch(() => props.open, (open) => {
  if (!open) return
  error.value = null
  if (!ingestPath.value) ingestPath.value = `match-${props.matchId.slice(0, 8)}/main`
})

async function start() {
  if (pending.value) return
  pending.value = true
  error.value = null
  try {
    await domain.startCapture({
      matchId: props.matchId,
      ingestPath: ingestPath.value,
      sourceKind: sourceKind.value,
      ...(sourceLabel.value.trim() ? { sourceLabel: sourceLabel.value.trim() } : {}),
      ...(secretRef.value.trim() ? { sourceConfigSecretRef: secretRef.value.trim() } : {}),
    })
    emit('changed')
    toast.success('影音來源已啟用')
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法啟用影音來源'; toast.error(error.value) }
  finally { pending.value = false }
}

async function stop(capture: CaptureSession) {
  if (stoppingId.value) return
  captureToStop.value = capture
}
async function confirmStop() {
  const capture = captureToStop.value
  captureToStop.value = null
  if (!capture || stoppingId.value) return
  stoppingId.value = capture.id
  error.value = null
  try { await domain.stopCapture(capture.id); emit('changed'); toast.success('影音來源已停止') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法停止影音來源'; toast.error(error.value) }
  finally { stoppingId.value = null }
}
</script>

<template>
  <UiAnimatedModal :open="open" title="影音來源" description="管理此場次的直播輸入" @close="emit('close')">
    <UiScrollArea class="capture-scroll">
      <section class="capture-dialog">
        <div class="capture-list"><div class="capture-title"><span>使用中</span><b>{{ activeCaptures.length }}</b></div><p v-if="!activeCaptures.length" class="empty">目前沒有直播來源</p><article v-for="capture in activeCaptures" :key="capture.id"><div><strong>{{ capture.sourceLabel || '直播來源' }}</strong><span><i :class="{ healthy: capture.health.toUpperCase() === 'HEALTHY' }" />{{ statusLabel(capture.status) }} · {{ healthLabel(capture.health) }}</span></div><button type="button" :disabled="Boolean(stoppingId)" @click="stop(capture)"><Square :size="12" />{{ stoppingId === capture.id ? '停止中…' : '停止' }}</button></article></div>
        <form @submit.prevent="start"><div class="capture-title"><span>新增直播來源</span></div><label>串流協定<select v-model="sourceKind"><option value="rtmp">RTMP</option><option value="srt">SRT</option><option value="rtsp">RTSP</option></select></label><label>來源名稱<input v-model="sourceLabel" maxlength="120" placeholder="主場攝影機" /></label><label class="wide">串流路徑<input v-model="ingestPath" maxlength="191" required placeholder="court/main" /></label><p class="publish-hint"><span>推流位址</span><code>{{ publishHint }}</code></p><details class="advanced"><summary>進階設定</summary><label>憑證參照<input v-model="secretRef" maxlength="200" placeholder="secret://capture/main" /></label></details><p v-if="error" class="error" role="alert">{{ error }}</p><button class="start" type="submit" :disabled="pending || !ingestPath.trim()">{{ pending ? '啟用中…' : '啟用來源' }}</button></form>
      </section>
    </UiScrollArea>
  </UiAnimatedModal>
  <ConfirmActionDialog :open="Boolean(captureToStop)" title="停止影音來源" :message="`停止「${captureToStop?.sourceLabel || '目前來源'}」的擷取？`" confirm-label="停止來源" danger @close="captureToStop = null" @confirm="confirmStop" />
</template>

<style scoped>
.capture-scroll{height:min(650px,calc(86dvh - 52px))}.capture-dialog{min-height:0;background:#11151a;color:#edf2f5}.capture-dialog button,.capture-dialog input,.capture-dialog select{min-height:36px;border:1px solid #343d46;border-radius:8px;background:#181d23;color:inherit}.capture-dialog button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;cursor:pointer}.capture-dialog button:disabled{opacity:.45;cursor:not-allowed}.capture-list,form{padding:14px}.capture-list{border-bottom:1px solid #2c333a;background:#14181d}.capture-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#aab3bd;font-size:.69rem;font-weight:750}.capture-title b{min-width:22px;padding:2px 7px;border-radius:999px;background:#29313a;color:#b8c0c8;text-align:center}.capture-list article{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #282f36}.capture-list article div{display:grid;gap:3px}.capture-list article span,.empty{color:#7e8994;font-size:.66rem}.capture-list article span{display:flex;align-items:center;gap:5px}.capture-list article i{width:6px;height:6px;border-radius:50%;background:#c99a2e}.capture-list article i.healthy{background:#2ec67d}.capture-list article button{min-height:31px;color:#ff9ca4;font-size:.67rem}form{display:grid;grid-template-columns:1fr 1fr;gap:10px}form .capture-title,form .wide,form .publish-hint,form .advanced,form .error,form .start{grid-column:1/-1}label{display:grid;gap:5px;color:#8e99a4;font-size:.66rem;font-weight:650}input,select{width:100%;padding:7px 9px;outline:0}input:focus,select:focus{border-color:#4c90c4;box-shadow:0 0 0 3px #2c8cca22}.publish-hint{display:grid;gap:4px;margin:0;padding:9px;border:1px solid #343d46;border-radius:8px;background:#151a20;color:#7f8a95;font-size:.63rem}.publish-hint code{overflow-wrap:anywhere;color:#8dc9f4}.advanced{color:#8e99a4;font-size:.66rem}.advanced summary{cursor:pointer;font-weight:700}.advanced label{margin-top:8px}.error{margin:0;padding:8px;border:1px solid #7b373d;border-radius:8px;background:#321b1e;color:#ffabb1;font-size:.67rem}.start{border-color:#2782c4!important;background:#12659f!important;color:#fff!important;font-size:.69rem;font-weight:750}@media(max-width:620px){form{grid-template-columns:1fr}}
</style>
