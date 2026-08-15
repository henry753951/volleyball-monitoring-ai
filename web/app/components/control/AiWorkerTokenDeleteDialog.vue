<script setup lang="ts">
import { KeyRound, TriangleAlert } from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { AiWorkerTokenSnapshot } from '~/lib/operationsMonitor'
import UiButton from '~/components/ui/Button.vue'

defineProps<{
  error: Error | null
  open: boolean
  pending: boolean
  token: DeepReadonly<AiWorkerTokenSnapshot> | null
}>()
const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="刪除 Worker Token"
    description="永久撤銷這組本機 Worker 憑證"
    width="compact"
    @close="emit('close')"
  >
    <div class="token-delete-dialog">
      <div class="token-delete-dialog__warning">
        <TriangleAlert :size="19" />
        <p>
          <strong>{{ token?.name }}</strong>
          <span
            >這個動作無法復原。若本機 Worker 正在使用此
            Token，它會在下一次心跳自動退出；尚未完成的工作會回到佇列。</span
          >
        </p>
      </div>
      <dl>
        <div>
          <dt><KeyRound :size="15" />Token</dt>
          <dd>{{ token?.tokenPrefix }}…</dd>
        </div>
        <div>
          <dt>最後使用</dt>
          <dd>
            {{ token?.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '尚未使用' }}
          </dd>
        </div>
      </dl>
      <p v-if="error" class="token-delete-dialog__error" role="alert">{{ error.message }}</p>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="pending" @click="emit('close')">取消</UiButton>
      <UiButton variant="destructive" :disabled="pending" @click="emit('confirm')">{{
        pending ? '刪除中…' : '刪除 Token'
      }}</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.token-delete-dialog {
  display: grid;
  gap: 16px;
  padding: 18px;
}
.token-delete-dialog__warning {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 10px;
  padding: 13px;
  border: 1px solid #5f2929;
  border-radius: 10px;
  background: #1d1112;
  color: #fca5a5;
}
.token-delete-dialog__warning p {
  display: grid;
  gap: 4px;
  margin: 0;
}
.token-delete-dialog__warning strong {
  color: #fee2e2;
  font-size: 0.76rem;
}
.token-delete-dialog__warning span {
  font-size: 0.66rem;
  line-height: 1.55;
}
.token-delete-dialog dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0;
  overflow: hidden;
  border: 1px solid #29292e;
  border-radius: 9px;
}
.token-delete-dialog dl > div {
  display: grid;
  gap: 7px;
  padding: 12px;
}
.token-delete-dialog dl > div + div {
  border-left: 1px solid #29292e;
}
.token-delete-dialog dt {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8d8d98;
  font-size: 0.62rem;
}
.token-delete-dialog dd {
  overflow: hidden;
  margin: 0;
  font-size: 0.7rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.token-delete-dialog__error {
  margin: 0;
  color: #fca5a5;
  font-size: 0.66rem;
}
</style>
