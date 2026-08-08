<script setup lang="ts">
defineProps<{ open: boolean; title: string; message: string; confirmLabel: string; danger?: boolean }>()
defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <UiAnimatedModal :open="open" :title="title" width="compact" @close="$emit('close')">
    <p class="confirm-message">{{ message }}</p>
    <template #footer><button type="button" class="secondary" @click="$emit('close')">取消</button><button type="button" class="confirm" :class="{ danger }" @click="$emit('confirm')">{{ confirmLabel }}</button></template>
  </UiAnimatedModal>
</template>

<style scoped>
.confirm-message{margin:0;padding:22px 18px;color:#b8c1ca;font-size:.76rem;line-height:1.65}:deep(.animated-modal__footer button){min-height:34px;padding:0 13px;border:1px solid #3d4751;border-radius:8px;background:#20262d;color:#e8edf1;font-weight:700}:deep(.animated-modal__footer .confirm){border-color:#287e55;background:#17623f}:deep(.animated-modal__footer .confirm.danger){border-color:#91434a;background:#6d2930}
</style>
