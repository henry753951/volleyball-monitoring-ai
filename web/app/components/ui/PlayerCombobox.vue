<script setup lang="ts">
import { Check, ChevronsUpDown, Search } from 'lucide-vue-next'
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport } from 'reka-ui'

export interface PlayerComboboxOption { value: string; label: string }
const props = withDefaults(defineProps<{ modelValue: string; options: PlayerComboboxOption[]; disabled?: boolean; placeholder?: string }>(), { disabled: false, placeholder: '選擇球員' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const displayValue = (value: string) => props.options.find(option => option.value === value)?.label ?? props.placeholder
</script>

<template>
  <ComboboxRoot :model-value="modelValue" :disabled="disabled" @update:model-value="emit('update:modelValue', String($event ?? ''))">
    <ComboboxAnchor class="player-combobox__anchor"><Search :size="13" /><ComboboxInput class="player-combobox__input" :display-value="displayValue" :placeholder="placeholder" /><ComboboxTrigger class="player-combobox__trigger" aria-label="展開球員選單"><ChevronsUpDown :size="14" /></ComboboxTrigger></ComboboxAnchor>
    <ComboboxPortal><ComboboxContent class="player-combobox__content" position="popper" :side-offset="5"><ComboboxViewport class="player-combobox__viewport"><ComboboxEmpty class="player-combobox__empty">找不到球員</ComboboxEmpty><ComboboxItem v-for="option in options" :key="option.value" class="player-combobox__item" :value="option.value"><span>{{ option.label }}</span><ComboboxItemIndicator><Check :size="14" /></ComboboxItemIndicator></ComboboxItem></ComboboxViewport></ComboboxContent></ComboboxPortal>
  </ComboboxRoot>
</template>

<style scoped>
.player-combobox__anchor{width:100%;height:31px;display:flex;align-items:center;gap:6px;padding:0 7px;border:1px solid #3f3f46;border-radius:7px;background:#18181b;color:#a1a1aa}.player-combobox__anchor:focus-within{border-color:#71717a;box-shadow:0 0 0 2px #71717a33}.player-combobox__input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:#f4f4f5;font-size:.67rem}.player-combobox__trigger{width:22px!important;min-height:22px!important;display:grid!important;place-items:center;padding:0!important;border:0!important;background:transparent!important;color:#a1a1aa!important}.player-combobox__content{z-index:1200;width:var(--reka-combobox-trigger-width);max-height:260px;overflow:hidden;border:1px solid #3f3f46;border-radius:8px;background:#18181b;color:#fafafa;box-shadow:0 18px 48px #000b}.player-combobox__viewport{padding:4px}.player-combobox__empty{padding:14px;color:#71717a;font-size:.67rem;text-align:center}.player-combobox__item{min-height:32px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px;border-radius:6px;outline:0;font-size:.67rem;cursor:default}.player-combobox__item[data-highlighted]{background:#27272a}.player-combobox__item[data-state="checked"]{color:#86efac}
</style>
