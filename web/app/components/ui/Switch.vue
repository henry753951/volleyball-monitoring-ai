<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'

withDefaults(defineProps<{ modelValue?: boolean; disabled?: boolean }>(), {
  modelValue: false,
  disabled: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <SwitchRoot
    class="ui-switch"
    :model-value="modelValue"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <SwitchThumb class="ui-switch__thumb" />
  </SwitchRoot>
</template>

<style scoped>
.ui-switch{width:42px;height:25px;display:flex;align-items:center;padding:2px;border:0;border-radius:999px;background:#c7ced6;cursor:pointer;transition:background-color 180ms ease-out}.ui-switch[data-state="checked"]{background:#1672d4}.ui-switch:disabled{cursor:not-allowed;opacity:.42}.ui-switch:focus-visible{box-shadow:0 0 0 3px #1672d43d}.ui-switch__thumb{width:21px;height:21px;display:block;border-radius:50%;background:#fff;box-shadow:0 2px 5px #11182736;transition:transform 220ms cubic-bezier(.22,1,.36,1)}.ui-switch__thumb[data-state="checked"]{transform:translateX(17px)}
@media(prefers-reduced-motion:reduce){.ui-switch,.ui-switch__thumb{transition:none}}
</style>
