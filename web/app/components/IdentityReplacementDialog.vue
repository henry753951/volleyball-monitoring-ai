<script setup lang="ts">
import UiButton from '~/components/ui/Button.vue'
import UiSwitch from '~/components/ui/Switch.vue'

defineProps<{
  open: boolean
  playerName: string
  occupiedTrackId: number
  targetTrackId: number
  warningEnabled: boolean
}>()
const emit = defineEmits<{
  close: []
  confirm: []
  'update:warningEnabled': [value: boolean]
}>()
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="取代球員指派"
    description="同一時間只能由一個追蹤框代表這位球員"
    width="compact"
    @close="emit('close')"
  >
    <div class="replacement-dialog__body">
      <p>
        <strong>{{ playerName }}</strong> 目前由 T{{
          String(occupiedTrackId).padStart(2, '0')
        }}
        使用。確認後會改指派到 T{{ String(targetTrackId).padStart(2, '0') }}。
      </p>
      <label
        ><span><b>顯示取代提醒</b><small>關閉後，之後會直接完成取代</small></span
        ><UiSwitch
          :model-value="warningEnabled"
          @update:model-value="emit('update:warningEnabled', $event)"
      /></label>
    </div>
    <template #footer
      ><UiButton variant="ghost" @click="emit('close')">取消</UiButton
      ><UiButton @click="emit('confirm')">確認取代</UiButton></template
    >
  </UiAnimatedModal>
</template>

<style scoped>
.replacement-dialog__body {
  display: grid;
  gap: 18px;
  padding: 20px;
}
.replacement-dialog__body p {
  margin: 0;
  color: #d4d4d8;
  font-size: 0.74rem;
  line-height: 1.65;
}
.replacement-dialog__body p strong {
  color: #fafafa;
}
.replacement-dialog__body label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px;
  border: 1px solid #27272a;
  border-radius: 10px;
  background: #18181b;
}
.replacement-dialog__body label > span {
  display: grid;
  gap: 3px;
}
.replacement-dialog__body label b {
  color: #f4f4f5;
  font-size: 0.68rem;
}
.replacement-dialog__body label small {
  color: #a1a1aa;
  font-size: 0.58rem;
}
</style>
