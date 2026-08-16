<script setup lang="ts">
import { DialogDescription } from 'reka-ui'
import UiButton from '~/components/ui/Button.vue'

defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string | null
  danger?: boolean
  pending?: boolean
}>()
defineEmits<{ close: []; confirm: []; secondary: [] }>()
</script>

<template>
  <UiAnimatedModal :open="open" :title="title" width="compact" @close="$emit('close')">
    <DialogDescription class="confirm-message">{{ message }}</DialogDescription>
    <template #footer>
      <div class="confirm-actions" :class="{ stacked: secondaryLabel }">
        <UiButton
          v-if="secondaryLabel"
          variant="default"
          :disabled="pending"
          @click="$emit('secondary')"
          >{{ secondaryLabel }}</UiButton
        >
        <UiButton
          :variant="danger ? 'destructive' : secondaryLabel ? 'outline' : 'default'"
          :disabled="pending"
          @click="$emit('confirm')"
          >{{ pending ? '處理中…' : confirmLabel }}</UiButton
        >
        <UiButton variant="ghost" :disabled="pending" @click="$emit('close')">取消</UiButton>
      </div>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  padding: 22px 18px;
  color: #d4d4d8;
  font-size: 0.76rem;
  line-height: 1.65;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
.confirm-actions.stacked {
  display: grid;
  grid-template-columns: 1fr;
  width: 100%;
}
.confirm-actions.stacked :deep(button) {
  width: 100%;
}
</style>
