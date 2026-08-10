<script setup lang="ts">
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

withDefaults(defineProps<{
  open?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}>(), { open: false, side: 'top', align: 'center' })

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
</script>

<template>
  <PopoverRoot :open="open" @update:open="emit('update:open', $event)">
    <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent class="ui-popover" :side="side" :align="align" :side-offset="9">
        <slot />
        <PopoverArrow class="ui-popover__arrow" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.ui-popover{z-index:1200;min-width:180px;padding:7px;border:1px solid #ffffff1a;border-radius:13px;background:rgba(27,31,37,.96);color:#f5f7fa;box-shadow:0 18px 46px #0007;backdrop-filter:blur(22px) saturate(150%);outline:0;transform-origin:var(--reka-popover-content-transform-origin);animation:ui-popover-in 180ms cubic-bezier(.22,1,.36,1)}
.ui-popover__arrow{fill:#1b1f25}.ui-popover:focus-visible{box-shadow:0 18px 46px #0007,0 0 0 3px #71aef03d}
@keyframes ui-popover-in{from{opacity:0;transform:scale(.96) translateY(3px)}}
@media(prefers-reduced-motion:reduce){.ui-popover{animation:none}}
@media(prefers-reduced-transparency:reduce){.ui-popover{background:#1b1f25;backdrop-filter:none}}
</style>
