<script setup lang="ts">
import { DatabaseZap, HardDrive, TriangleAlert } from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { Match } from '~/lib/coreDomain'
import type { MatchMediaSnapshot } from '~/lib/operationsMonitor'
import UiButton from '~/components/ui/Button.vue'

const props = defineProps<{ match: DeepReadonly<Match> | null; media: MatchMediaSnapshot | null; open: boolean; pending: boolean; error: Error | null }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const confirmation = ref('')
watch(() => props.open, open => { if (open) confirmation.value = '' })

function bytes(value: string | undefined) {
  const amount = Number(value ?? 0)
  if (!amount) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1)
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
</script>

<template>
  <UiAnimatedModal :open="open" title="刪除場次" description="這項操作會同步清理媒體與分析資料" width="compact" @close="emit('close')">
    <div class="delete-dialog">
      <div class="delete-warning"><TriangleAlert :size="19" /><p><strong>{{ match?.title }}</strong><span>場次、名單、標記、DVR、片段與分析結果會永久移除。</span></p></div>
      <dl><div><dt><HardDrive :size="15" />媒體容量</dt><dd>{{ bytes(media?.storedBytes) }}</dd></div><div><dt><DatabaseZap :size="15" />採集資料</dt><dd>{{ media?.captureCount ?? 0 }} 來源 · {{ media?.segmentCount ?? 0 }} segments</dd></div></dl>
      <label><span>輸入「刪除」以確認</span><input v-model="confirmation" autocomplete="off" /></label>
      <p v-if="error" class="delete-error" role="alert">{{ error.message }}</p>
    </div>
    <template #footer><UiButton variant="ghost" :disabled="pending" @click="emit('close')">取消</UiButton><UiButton variant="destructive" :disabled="pending || confirmation !== '刪除'" @click="emit('confirm')">{{ pending ? '清理中…' : '刪除場次與媒體' }}</UiButton></template>
  </UiAnimatedModal>
</template>

<style scoped>
.delete-dialog{display:grid;gap:16px;padding:18px;overflow:auto}.delete-warning{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:13px;border:1px solid #5f2929;border-radius:10px;background:#1d1112;color:#fca5a5}.delete-warning p{display:grid;gap:4px;margin:0}.delete-warning strong{font-size:.76rem;color:#fee2e2}.delete-warning span{font-size:.66rem;line-height:1.55}.delete-dialog dl{display:grid;grid-template-columns:1fr 1fr;margin:0;border:1px solid #29292e;border-radius:9px;overflow:hidden}.delete-dialog dl>div{display:grid;gap:7px;padding:12px}.delete-dialog dl>div+div{border-left:1px solid #29292e}.delete-dialog dt{display:flex;align-items:center;gap:6px;color:#8d8d98;font-size:.62rem}.delete-dialog dd{margin:0;font-size:.74rem;font-weight:700}.delete-dialog label{display:grid;gap:7px;color:#a1a1aa;font-size:.66rem}.delete-dialog input{min-height:40px;padding:0 11px;border:1px solid #3f3f46;border-radius:8px;outline:0;background:#111114;color:#fff}.delete-dialog input:focus{border-color:#a1a1aa}.delete-error{margin:0;color:#fca5a5;font-size:.66rem}
</style>
