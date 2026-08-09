<script setup lang="ts">
import { DialogDescription } from 'reka-ui'
import UiButton from '~/components/ui/Button.vue'

defineProps<{ open: boolean; title: string; message: string; confirmLabel: string; danger?: boolean }>()
defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <UiAnimatedModal :open="open" :title="title" width="compact" @close="$emit('close')">
    <DialogDescription class="confirm-message">{{ message }}</DialogDescription>
    <template #footer><UiButton variant="ghost" @click="$emit('close')">取消</UiButton><UiButton :variant="danger ? 'destructive' : 'default'" @click="$emit('confirm')">{{ confirmLabel }}</UiButton></template>
  </UiAnimatedModal>
</template>

<style scoped>
.confirm-message{margin:0;padding:22px 18px;color:#d4d4d8;font-size:.76rem;line-height:1.65}
</style>
