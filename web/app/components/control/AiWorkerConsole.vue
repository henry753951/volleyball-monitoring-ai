<script setup lang="ts">
import {
  Check,
  CircleDot,
  Copy,
  Cpu,
  KeyRound,
  Plus,
  RotateCw,
  Trash2,
  Wifi,
} from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { AiWorkerSnapshot, AiWorkerTokenSnapshot, AiWorkSnapshot } from '~/lib/operationsMonitor'

const props = defineProps<{
  activeJobs: number
  endpoint: string
  tokens: readonly DeepReadonly<AiWorkerTokenSnapshot>[]
  workers: readonly DeepReadonly<AiWorkerSnapshot>[]
  work: readonly DeepReadonly<AiWorkSnapshot>[]
}>()

const emit = defineEmits<{
  copy: [value: string]
  createToken: []
  deleteToken: [token: DeepReadonly<AiWorkerTokenSnapshot>]
  deleteWorker: [worker: DeepReadonly<AiWorkerSnapshot>]
  rotateToken: [token: DeepReadonly<AiWorkerTokenSnapshot>]
  toggleToken: [token: DeepReadonly<AiWorkerTokenSnapshot>]
}>()

const onlineWorkers = computed(() => props.workers.filter(worker => worker.status === 'online'))
const averageLatency = computed(() => {
  const values = onlineWorkers.value.flatMap(worker => worker.latencyMs === null ? [] : [worker.latencyMs])
  if (!values.length) return null
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length)
})
const availableSlots = computed(() => onlineWorkers.value.reduce(
  (total, worker) => total + Math.max(0, worker.maxConcurrency - worker.activeJobs),
  0,
))

function currentWork(worker: DeepReadonly<AiWorkerSnapshot>) {
  return props.work.find(job => job.workerInstanceKey === worker.instanceKey && ['QUEUED', 'RUNNING'].includes(job.status.toUpperCase())) ?? null
}

function relativeTime(value: string | null) {
  if (!value) return '尚未回應'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000))
  if (seconds < 2) return '剛剛'
  if (seconds < 60) return `${seconds} 秒前`
  return `${Math.floor(seconds / 60)} 分前`
}
</script>

<template>
  <div class="worker-console">
    <section class="engine-surface" aria-labelledby="engine-title">
      <header class="engine-header">
        <h2 id="engine-title">連線與存取</h2>
        <button type="button" class="primary-button" @click="emit('createToken')">
          <Plus :size="15" />建立 Token
        </button>
      </header>

      <dl class="engine-stats">
        <div><dt>在線 Worker</dt><dd>{{ onlineWorkers.length }}</dd></div>
        <div><dt>可用工作槽</dt><dd>{{ availableSlots }}</dd></div>
        <div><dt>執行中</dt><dd>{{ activeJobs }}</dd></div>
        <div><dt>平均延遲</dt><dd>{{ averageLatency === null ? '—' : `${averageLatency} ms` }}</dd></div>
      </dl>

      <div class="connection-row">
        <Wifi :size="15" />
        <span>WebSocket</span>
        <code>{{ endpoint }}</code>
        <button type="button" aria-label="複製 WebSocket 位址" title="複製位址" @click="emit('copy', endpoint)">
          <Copy :size="14" />
        </button>
      </div>

      <div class="credentials">
        <div class="credentials-heading">
          <div><h3>存取 Token</h3><p>Token 只在建立或輪替時顯示一次</p></div>
          <span>{{ tokens.filter(token => token.enabled).length }} 組啟用</span>
        </div>
        <div v-if="tokens.length" class="credential-list">
          <div v-for="token in tokens" :key="token.id" class="credential-row" :class="{ disabled: !token.enabled }">
            <KeyRound :size="15" />
            <div>
              <strong>{{ token.name }}</strong>
              <small>{{ token.tokenPrefix }}… · {{ token.lastUsedAt ? `${relativeTime(token.lastUsedAt)}使用` : '尚未使用' }}</small>
            </div>
            <span class="credential-state"><i />{{ token.enabled ? '啟用' : '停用' }}</span>
            <button type="button" :aria-label="token.enabled ? `停用 ${token.name}` : `啟用 ${token.name}`" :title="token.enabled ? '停用 Token' : '啟用 Token'" @click="emit('toggleToken', token)">
              <Check v-if="token.enabled" :size="14" /><CircleDot v-else :size="14" />
            </button>
            <button type="button" :aria-label="`輪替 ${token.name}`" title="輪替 Token" @click="emit('rotateToken', token)"><RotateCw :size="14" /></button>
            <button type="button" :aria-label="`刪除 ${token.name}`" class="delete-token" title="永久刪除 Token" @click="emit('deleteToken', token)"><Trash2 :size="14" /></button>
          </div>
        </div>
        <button v-else type="button" class="first-token" @click="emit('createToken')">
          <KeyRound :size="16" /><span><strong>建立第一組 Token</strong><small>供 AI Worker 安全連線</small></span>
        </button>
      </div>
    </section>

    <section class="fleet-surface" aria-labelledby="fleet-title">
      <header class="fleet-header">
        <div><h2 id="fleet-title">Worker 狀態</h2><p>持續心跳與 transport ping/pong 延遲</p></div>
        <span :class="onlineWorkers.length ? 'online' : 'offline'"><i />{{ onlineWorkers.length }} 在線</span>
      </header>
      <div v-if="!workers.length" class="fleet-empty">
        <Cpu :size="22" />
        <strong>尚無 Worker 連線</strong>
        <span>使用上方 WebSocket 位址與 Token 啟動 volleyball-analysis-engine</span>
      </div>
      <div v-else class="fleet-list">
        <article v-for="worker in workers" :key="worker.id">
          <span class="worker-avatar"><Cpu :size="17" /></span>
          <div class="worker-name">
            <strong>{{ worker.instanceKey }}</strong>
            <small>{{ worker.providerBuildId }} · SDK {{ worker.sdkVersion }}</small>
            <small v-if="worker.accelerator" class="worker-hardware">{{ worker.accelerator }} · 模型 {{ worker.modelVersion ?? '未標示' }}</small>
            <small v-if="currentWork(worker)" class="worker-current">目前：{{ currentWork(worker)?.matchTitle }} · {{ currentWork(worker)?.stage ?? currentWork(worker)?.status }}</small>
            <small v-else class="worker-current">目前：待命</small>
          </div>
          <div class="worker-load"><span><i :style="{ width: `${Math.min(100, worker.utilization * 100)}%` }" /></span><small>{{ worker.activeJobs }} / {{ worker.maxConcurrency }} 工作槽</small></div>
          <div class="worker-latency"><strong>{{ worker.latencyMs === null ? '—' : `${worker.latencyMs} ms` }}</strong><small>RTT · pong {{ relativeTime(worker.lastPongAt) }}</small></div>
          <span class="worker-state" :class="worker.status"><i />{{ worker.status === 'online' ? `心跳 ${relativeTime(worker.lastSeenAt)}` : worker.status === 'stale' ? '心跳逾時' : '離線' }}</span>
          <button v-if="worker.status !== 'online'" type="button" class="delete-worker" :disabled="!worker.canDelete" title="移除離線 Worker" @click="emit('deleteWorker', worker)"><Trash2 :size="14" /></button>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.worker-console{display:grid;gap:16px}.engine-surface,.fleet-surface{overflow:hidden;border:1px solid #303033;border-radius:14px;background:#1b1b1c}.engine-header,.fleet-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 20px;border-bottom:1px solid #2b2b2e}.engine-mark,.worker-avatar{display:grid;place-items:center;border-radius:9px;background:#29292c;color:#d7d9dc}.engine-header h2,.fleet-header h2,.credentials-heading h3{margin:0;color:#f3f4f5}.engine-header h2{font-size:.7rem;letter-spacing:-.015em}.fleet-header p,.credentials-heading p{margin:4px 0 0;color:#85858a;font-size:.54rem}.primary-button{height:36px;display:flex;align-items:center;gap:7px;padding:0 13px;border:1px solid #e6e6e8;border-radius:8px;background:#f1f2f3;color:#111216;font-size:.61rem;font-weight:760}.engine-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:16px 20px}.engine-stats>div{display:grid;gap:5px;padding-left:16px;border-left:1px solid #2b2b2e}.engine-stats>div:first-child{padding-left:0;border-left:0}.engine-stats dt{color:#85858a;font-size:.51rem}.engine-stats dd{margin:0;font-size:.9rem;font-weight:730;font-variant-numeric:tabular-nums}.connection-row{min-height:44px;display:grid;grid-template-columns:18px auto minmax(0,1fr) 30px;align-items:center;gap:10px;margin:0 20px 18px;padding:0 10px;border:1px solid #2c2c2f;border-radius:8px;background:#171718;color:#929297}.connection-row>span{font-size:.5rem}.connection-row code{overflow:hidden;color:#c4c7cb;font-size:.52rem;text-overflow:ellipsis;white-space:nowrap}.connection-row button,.credential-row button,.delete-worker{width:30px;height:30px;display:grid;place-items:center;border:1px solid transparent;border-radius:7px;background:transparent;color:#aeb1b6}.connection-row button:hover,.credential-row button:hover,.delete-worker:hover{border-color:#38383b;background:#29292c;color:#fff}.credential-row .delete-token:hover{border-color:#563033;background:#351b1d;color:#fca5a5}.credentials{padding:0 20px 12px}.credentials-heading{display:flex;align-items:flex-end;justify-content:space-between;padding:0 0 8px}.credentials-heading h3,.fleet-header h2{font-size:.66rem}.credentials-heading>span,.fleet-header>span{color:#8c8c91;font-size:.51rem}.credential-list{display:grid}.credential-row{min-height:52px;display:grid;grid-template-columns:22px minmax(0,1fr) auto 30px 30px 30px;align-items:center;gap:8px;border-top:1px solid #2b2b2e;color:#aeb1b6}.credential-row.disabled{opacity:.48}.credential-row>div{display:grid;gap:3px}.credential-row strong{color:#e9eaec;font-size:.57rem}.credential-row small{color:#7f7f84;font-size:.49rem}.credential-state{display:flex;align-items:center;gap:6px;color:#a0a0a5;font-size:.51rem}.credential-state i,.fleet-header>span i,.worker-state i{width:6px;height:6px;border-radius:50%;background:#4bc28a}.credential-row.disabled .credential-state i,.fleet-header>span.offline i,.worker-state.offline i{background:#d56f6d}.first-token{width:100%;min-height:58px;display:flex;align-items:center;justify-content:center;gap:10px;border:0;border-top:1px solid #2b2b2e;background:transparent;color:#989ba1}.first-token span{display:grid;gap:3px;text-align:left}.first-token strong{color:#d9dbde;font-size:.57rem}.first-token small{font-size:.49rem}.fleet-header>span{display:flex;align-items:center;gap:6px}.fleet-list article{min-height:82px;display:grid;grid-template-columns:34px minmax(190px,1.1fr) minmax(150px,.75fr) 120px 120px 30px;align-items:center;gap:12px;padding:8px 20px;border-top:1px solid #2b2b2e}.worker-avatar{width:32px;height:32px}.worker-name,.worker-latency{display:grid;gap:3px}.worker-name strong,.worker-latency strong{overflow:hidden;font-size:.59rem;text-overflow:ellipsis;white-space:nowrap}.worker-name small,.worker-latency small,.worker-load small{color:#7f7f84;font-size:.49rem}.worker-name .worker-hardware{color:#a8b7d2}.worker-name .worker-current{color:#91c6a8}.worker-load{display:grid;gap:6px}.worker-load>span{height:4px;overflow:hidden;border-radius:2px;background:#303033}.worker-load>span i{display:block;height:100%;background:#55c58e}.worker-state{display:flex;align-items:center;gap:6px;color:#a0a0a5;font-size:.51rem}.worker-state.stale i{background:#d4a255}.delete-worker:disabled{opacity:.3}.fleet-empty{min-height:160px;display:grid;place-items:center;align-content:center;gap:7px;color:#7f7f84}.fleet-empty strong{color:#aeb1b6;font-size:.64rem}.fleet-empty span{font-size:.52rem}
@media(max-width:980px){.fleet-list article{grid-template-columns:34px minmax(0,1fr) 130px 100px auto 30px}}
@media(max-width:700px){.engine-header{align-items:flex-start}.engine-stats{grid-template-columns:repeat(2,1fr);gap:14px}.engine-stats>div:nth-child(odd){padding-left:0}.fleet-list article{grid-template-columns:34px minmax(0,1fr) auto}.worker-load,.worker-latency{grid-column:2}.worker-state{grid-column:3;grid-row:1}.delete-worker{grid-column:3}.credential-row{grid-template-columns:22px minmax(0,1fr) 30px 30px 30px}.credential-state{display:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
