<script setup lang="ts">
import { Cpu, TriangleAlert } from 'lucide-vue-next'
import type { AiWorkerSnapshot } from '~/lib/operationsMonitor'
import UiButton from '~/components/ui/Button.vue'

defineProps<{
  error: Error | null
  open: boolean
  pending: boolean
  worker: AiWorkerSnapshot | null
}>()
const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <UiAnimatedModal :open="open" title="移除 AI Worker" description="清除中央端的逾時連線紀錄" width="compact" @close="emit('close')">
    <div class="worker-delete-dialog">
      <div class="worker-delete-dialog__warning">
        <TriangleAlert :size="19" />
        <p><strong>{{ worker?.instanceKey }}</strong><span>已完成的分析結果會保留；遠端 Worker 再次啟動時仍可重新註冊。</span></p>
      </div>
      <dl>
        <div><dt><Cpu :size="15" />Build</dt><dd>{{ worker?.providerBuildId }}</dd></div>
        <div><dt>最後心跳</dt><dd>{{ worker ? new Date(worker.lastSeenAt).toLocaleString() : '—' }}</dd></div>
      </dl>
      <p v-if="error" class="worker-delete-dialog__error" role="alert">{{ error.message }}</p>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="pending" @click="emit('close')">取消</UiButton>
      <UiButton variant="destructive" :disabled="pending" @click="emit('confirm')">{{ pending ? '移除中…' : '移除 Worker' }}</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.worker-delete-dialog{display:grid;gap:16px;padding:18px}.worker-delete-dialog__warning{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:13px;border:1px solid #5f2929;border-radius:10px;background:#1d1112;color:#fca5a5}.worker-delete-dialog__warning p{display:grid;gap:4px;margin:0}.worker-delete-dialog__warning strong{color:#fee2e2;font-size:.76rem}.worker-delete-dialog__warning span{font-size:.66rem;line-height:1.55}.worker-delete-dialog dl{display:grid;grid-template-columns:1fr 1fr;margin:0;overflow:hidden;border:1px solid #29292e;border-radius:9px}.worker-delete-dialog dl>div{display:grid;gap:7px;padding:12px}.worker-delete-dialog dl>div+div{border-left:1px solid #29292e}.worker-delete-dialog dt{display:flex;align-items:center;gap:6px;color:#8d8d98;font-size:.62rem}.worker-delete-dialog dd{overflow:hidden;margin:0;font-size:.7rem;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.worker-delete-dialog__error{margin:0;color:#fca5a5;font-size:.66rem}
</style>
