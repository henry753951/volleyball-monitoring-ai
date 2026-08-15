<script setup lang="ts">
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'

export interface TabsOption {
  value: string
  label: string
  count?: number
}

defineProps<{
  options: readonly TabsOption[]
  ariaLabel?: string
}>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <TabsRoot v-model="model" class="ui-tabs">
    <TabsList class="ui-tabs__list" :aria-label="ariaLabel">
      <TabsTrigger
        v-for="option in options"
        :key="option.value"
        class="ui-tabs__trigger"
        :value="option.value"
      >
        <span>{{ option.label }}</span>
        <small v-if="option.count !== undefined">{{ option.count }}</small>
      </TabsTrigger>
    </TabsList>
  </TabsRoot>
</template>

<style scoped>
.ui-tabs {
  min-width: 0;
}
.ui-tabs__list {
  display: inline-flex;
  min-width: max-content;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid #d8dde3;
  border-radius: 9px;
  background: #e9edf1;
}
.ui-tabs__trigger {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  border-radius: 6px;
  outline: 0;
  background: transparent;
  color: #68727d;
  font-size: 0.69rem;
  font-weight: 680;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}
.ui-tabs__trigger:hover {
  color: #282e35;
}
.ui-tabs__trigger[data-state='active'] {
  background: #fff;
  color: #11151a;
  box-shadow: 0 1px 3px #1f293719;
}
.ui-tabs__trigger:focus-visible {
  box-shadow: 0 0 0 3px #0670df32;
}
.ui-tabs__trigger small {
  min-width: 16px;
  color: #7c858f;
  font-size: 0.57rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.ui-tabs__trigger[data-state='active'] small {
  color: #3977b8;
}
@media (prefers-reduced-motion: reduce) {
  .ui-tabs__trigger {
    transition: none;
  }
}
</style>
