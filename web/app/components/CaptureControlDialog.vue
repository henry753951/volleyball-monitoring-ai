<script setup lang="ts">
import { RadioTower, Square, X } from 'lucide-vue-next'
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
const error = ref<string | null>(null)
const activeCaptures = computed(() => props.captures.filter(capture => ['STARTING', 'LIVE', 'STOPPING'].includes(capture.status.toUpperCase())))
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
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法建立 capture session' }
  finally { pending.value = false }
}

async function stop(capture: CaptureSession) {
  if (stoppingId.value || !window.confirm(`停止 ${capture.sourceLabel || capture.id}？後續 MediaMTX 片段將不再匯入此 session。`)) return
  stoppingId.value = capture.id
  error.value = null
  try { await domain.stopCapture(capture.id); emit('changed') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '無法停止 capture session' }
  finally { stoppingId.value = null }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="capture-backdrop" role="presentation" @mousedown.self="emit('close')">
      <section class="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title">
        <header><div><h2 id="capture-title"><RadioTower :size="18" />串流來源</h2><p>Server-side DVR capture；只保存 secret reference，不接受密鑰內容。</p></div><button type="button" aria-label="關閉串流來源" @click="emit('close')"><X :size="17" /></button></header>
        <div class="capture-list"><div class="capture-title"><span>目前來源</span><b>{{ activeCaptures.length }}</b></div><p v-if="!activeCaptures.length" class="empty">尚無執行中的 capture。</p><article v-for="capture in activeCaptures" :key="capture.id"><div><strong>{{ capture.sourceLabel || capture.id }}</strong><span>{{ capture.status.toLowerCase() }} · {{ capture.health.toLowerCase() }}</span></div><button type="button" :disabled="Boolean(stoppingId)" @click="stop(capture)"><Square :size="13" />{{ stoppingId === capture.id ? '停止中…' : '停止' }}</button></article></div>
        <form @submit.prevent="start"><div class="capture-title"><span>新增來源</span></div><label>Protocol<select v-model="sourceKind"><option value="rtmp">RTMP publish</option><option value="srt">SRT publish</option><option value="rtsp">RTSP publish</option><option value="fixture">Fixture / external</option></select></label><label>顯示名稱<input v-model="sourceLabel" maxlength="120" placeholder="例如：主場攝影機" /></label><label>MediaMTX ingest path<input v-model="ingestPath" maxlength="191" required placeholder="court/main" /></label><label>Secret reference（選填）<input v-model="secretRef" maxlength="200" placeholder="secret://capture/main" /></label><p class="publish-hint"><span>Publisher target</span><code>{{ publishHint }}</code></p><p v-if="error" class="error" role="alert">{{ error }}</p><button class="start" type="submit" :disabled="pending || !ingestPath.trim()">{{ pending ? '建立中…' : '建立 capture session' }}</button></form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.capture-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:#020304c9;color:#eef2f5;font-family:"Segoe UI Variable Text",Aptos,"Segoe UI",sans-serif}.capture-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;border:1px solid #3c454e;border-radius:10px;background:#12161a;box-shadow:0 24px 90px #000c}.capture-dialog>header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:16px 18px;border-bottom:1px solid #30373e}.capture-dialog h2{display:flex;align-items:center;gap:8px;margin:0;font-size:1rem}.capture-dialog header p{margin:4px 0 0;color:#99a4ae;font-size:.72rem}.capture-dialog button,.capture-dialog input,.capture-dialog select{min-height:36px;border:1px solid #46515b;border-radius:6px;background:#1d2329;color:inherit}.capture-dialog button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;cursor:pointer}.capture-dialog button:disabled{opacity:.45;cursor:not-allowed}.capture-list,form{padding:14px 18px}.capture-list{border-bottom:1px solid #30373e}.capture-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#cbd3da;font-size:.75rem;font-weight:700}.capture-title b{padding:2px 7px;border-radius:12px;background:#293139}.capture-list article{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #282f35}.capture-list article div{display:grid;gap:2px}.capture-list article span,.empty{color:#8e99a3;font-size:.7rem}.capture-list article button{min-height:31px;color:#ffafb3;font-size:.7rem}form{display:grid;grid-template-columns:1fr 1fr;gap:11px}form .capture-title,form .publish-hint,form .error,form .start{grid-column:1/-1}label{display:grid;gap:5px;color:#aab3bc;font-size:.69rem}input,select{width:100%;padding:7px 9px}.publish-hint{display:grid;gap:4px;margin:0;padding:9px;border:1px solid #34424d;border-radius:6px;background:#0e1215;color:#8fa2b2;font-size:.66rem}.publish-hint code{overflow-wrap:anywhere;color:#a8d1f2}.error{margin:0;padding:8px;border:1px solid #87464b;border-radius:6px;background:#381b1e;color:#ffc0c3;font-size:.7rem}.start{border-color:#238354!important;background:#176b44!important;color:#eafff3!important}@media(max-width:620px){form{grid-template-columns:1fr}}
</style>
