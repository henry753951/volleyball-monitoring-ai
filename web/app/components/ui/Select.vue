<script setup lang="ts">
import { Check, ChevronDown } from 'lucide-vue-next'
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption[]
    placeholder?: string
  }>(),
  { placeholder: '請選擇' },
)

const model = defineModel<string>({ required: true })
const attrs = useAttrs()
const ariaLabel = computed(() =>
  typeof attrs['aria-label'] === 'string' ? attrs['aria-label'] : undefined,
)
</script>

<template>
  <SelectRoot v-model="model">
    <SelectTrigger class="ui-select__trigger" :aria-label="ariaLabel">
      <SelectValue :placeholder="props.placeholder" />
      <ChevronDown :size="14" aria-hidden="true" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="ui-select__content" position="popper" :side-offset="5">
        <SelectViewport class="ui-select__viewport">
          <SelectItem
            v-for="option in props.options"
            :key="option.value"
            class="ui-select__item"
            :value="option.value"
            :disabled="option.disabled"
          >
            <SelectItemIndicator class="ui-select__indicator"
              ><Check :size="13"
            /></SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style>
.ui-select__trigger {
  width: 100%;
  min-width: 0;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid #27272a;
  border-radius: 8px;
  outline: 0;
  background: #18181b;
  color: #fafafa;
  font-size: 0.72rem;
  text-align: left;
}
.ui-select__trigger:focus-visible {
  border-color: #71717a;
  box-shadow: 0 0 0 2px #fafafa24;
}
.ui-select__trigger[data-placeholder] {
  color: #a1a1aa;
}
.ui-select__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ui-select__content {
  z-index: 100;
  min-width: var(--reka-select-trigger-width);
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #202023;
  color: #fafafa;
  box-shadow: 0 14px 32px #0009;
}
.ui-select__viewport {
  padding: 5px;
}
.ui-select__item {
  position: relative;
  min-height: 36px;
  display: flex;
  align-items: center;
  padding: 7px 10px 7px 30px;
  border-radius: 7px;
  outline: 0;
  font-size: 0.72rem;
  cursor: default;
  user-select: none;
}
.ui-select__item[data-highlighted] {
  background: #3f3f46;
}
.ui-select__item[data-disabled] {
  opacity: 0.45;
}
.ui-select__indicator {
  position: absolute;
  left: 9px;
  display: grid;
  place-items: center;
}
</style>
