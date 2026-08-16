<script setup lang="ts">
import { Check, ChevronsUpDown, Search } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'
import type { PlayerComboboxOption } from '~/types/identityAssignment'
import UiHoverCard from './HoverCard.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: PlayerComboboxOption[]
    disabled?: boolean
    placeholder?: string
    previewSide?: 'left' | 'right'
  }>(),
  { disabled: false, placeholder: '選擇球員', previewSide: 'left' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const CLEAR_VALUE = '__clear_player_assignment__'
const internalValue = computed(() => (props.modelValue === '' ? CLEAR_VALUE : props.modelValue))
const displayValue = (value: string) =>
  props.options.find(option => option.value === (value === CLEAR_VALUE ? '' : value))?.label ??
  props.placeholder
const open = ref(false)

function setOpen(value: boolean) {
  open.value = value
}

function emitValue(value: unknown) {
  const nextValue = String(value ?? '')
  emit('update:modelValue', nextValue === CLEAR_VALUE ? '' : nextValue)
}

function openFromAnchor() {
  if (!props.disabled) open.value = true
}
</script>

<template>
  <ComboboxRoot
    :model-value="internalValue"
    :open="open"
    :disabled="disabled"
    @update:open="setOpen"
    @update:model-value="emitValue"
  >
    <ComboboxAnchor class="player-combobox__anchor" @click="openFromAnchor"
      ><Search :size="13" /><ComboboxInput
        class="player-combobox__input"
        :display-value="displayValue"
        :placeholder="placeholder" /><ComboboxTrigger
        class="player-combobox__trigger"
        aria-label="展開球員選單"
        ><ChevronsUpDown :size="14" /></ComboboxTrigger
    ></ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        class="player-combobox__content"
        position="popper"
        align="end"
        :side-offset="6"
        :collision-padding="12"
      >
        <div class="player-combobox__layout">
          <ComboboxViewport class="player-combobox__viewport">
            <ComboboxEmpty class="player-combobox__empty">找不到球員</ComboboxEmpty>
            <UiHoverCard
              v-for="option in options"
              :key="option.value"
              :side="previewSide"
              :disabled="!option.value || !$slots.preview"
              content-class="player-hover-card"
            >
              <template #trigger>
                <ComboboxItem
                  class="player-combobox__item"
                  :data-tone="option.tone ?? 'default'"
                  :value="option.value === '' ? CLEAR_VALUE : option.value"
                >
                  <span class="player-combobox__copy">
                    <span v-if="option.playerName" class="player-combobox__player-line">
                      <b class="player-combobox__jersey">#{{ option.jerseyNumber }}</b>
                      <span
                        v-if="option.position"
                        class="player-combobox__position-badge"
                        :title="option.position === 'UNSPECIFIED' ? '位置未設定' : option.position"
                      >
                        {{ option.position === 'UNSPECIFIED' ? '—' : option.position }}
                      </span>
                      <b class="player-combobox__name" :title="option.playerName">
                        {{ option.playerName }}
                      </b>
                    </span>
                    <b v-else class="player-combobox__fallback">{{ option.label }}</b>
                    <small v-if="option.description">{{ option.description }}</small>
                  </span>
                  <ComboboxItemIndicator class="player-combobox__indicator"
                    ><Check :size="14"
                  /></ComboboxItemIndicator>
                </ComboboxItem>
              </template>
              <slot name="preview" :option="option" />
            </UiHoverCard>
          </ComboboxViewport>
        </div>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<style>
.player-combobox__anchor {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  background: #18181b;
  color: #a1a1aa;
  transition:
    border-color 140ms ease-out,
    background-color 140ms ease-out,
    box-shadow 140ms ease-out;
  cursor: pointer;
}
.player-combobox__anchor:hover {
  border-color: #52525b;
  background: #202024;
}
.player-combobox__anchor:focus-within {
  border-color: #71717a;
  box-shadow: 0 0 0 2px #71717a33;
}
.player-combobox__input {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  border: 0;
  outline: 0;
  background: transparent;
  color: #f4f4f5;
  font-size: 0.67rem;
  cursor: text;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-combobox__trigger {
  width: 22px !important;
  min-height: 22px !important;
  display: grid !important;
  place-items: center;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #a1a1aa !important;
}
.player-combobox__content {
  z-index: 1300;
  max-width: calc(100vw - 24px);
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 11px;
  background: #18181b;
  color: #fafafa;
  box-shadow: 0 18px 48px #000b;
  transform-origin: var(--reka-combobox-content-transform-origin);
}
.player-combobox__content[data-state='open'] {
  animation: player-combobox-in 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.player-combobox__content[data-state='closed'] {
  animation: player-combobox-out 120ms cubic-bezier(0.4, 0, 1, 1) both;
}
.player-combobox__layout {
  width: max(240px, var(--reka-combobox-trigger-width));
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.player-combobox__viewport {
  max-height: 286px;
  padding: 5px;
  overflow: auto;
}
.player-combobox__empty {
  padding: 18px;
  color: #a1a1aa;
  font-size: 0.67rem;
  text-align: center;
}
.player-combobox__item {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  outline: 0;
  font-size: 0.67rem;
  cursor: default;
}
.player-combobox__item[data-highlighted] {
  background: #27272a;
}
.player-combobox__item[data-state='checked'] {
  color: #86efac;
}
.player-combobox__item[data-tone='occupied'] .player-combobox__copy small {
  color: #e2bd77;
}
.player-combobox__copy {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 2px;
  overflow: hidden;
}
.player-combobox__player-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}
.player-combobox__jersey,
.player-combobox__position-badge {
  flex: none;
}
.player-combobox__jersey,
.player-combobox__fallback {
  color: inherit;
  font-size: 0.68rem;
  font-weight: 700;
}
.player-combobox__position-badge {
  padding: 2px 4px;
  border: 1px solid #3d5968;
  border-radius: 4px;
  background: #22333e;
  color: #b9dcf0;
  font-size: 0.49rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  line-height: 1;
}
.player-combobox__name {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 0.68rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-combobox__copy b {
  color: inherit;
}
.player-combobox__copy small {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: #a1a1aa;
  font-size: 0.55rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-combobox__indicator {
  flex: none;
}
.player-combobox__anchor[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.5;
}
.player-hover-card {
  width: min(250px, calc(100vw - 24px));
}
@keyframes player-combobox-in {
  from {
    opacity: 0;
    filter: blur(3px);
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0) scale(1);
  }
}
@keyframes player-combobox-out {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.98);
  }
}
@media (prefers-reduced-motion: reduce) {
  .player-combobox__anchor,
  .player-combobox__content {
    animation: none;
    transition: none;
  }
}
</style>
