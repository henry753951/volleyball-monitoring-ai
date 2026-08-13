<script setup lang="ts">
import { PopoverAnchor, PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

withDefaults(defineProps<{
  open?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  collisionPadding?: number
  sticky?: 'partial' | 'always'
  contentClass?: string
  ariaLabel?: string
}>(), {
  open: false,
  side: 'top',
  align: 'center',
  sideOffset: 9,
  collisionPadding: 12,
  sticky: 'partial',
  contentClass: '',
  ariaLabel: undefined,
})

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
</script>

<template>
  <PopoverRoot :open="open" @update:open="emit('update:open', $event)">
    <PopoverAnchor v-if="$slots.anchor" as-child><slot name="anchor" /></PopoverAnchor>
    <PopoverTrigger v-else-if="$slots.trigger" as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :class="['ui-popover', contentClass]"
        :side="side"
        :align="align"
        :side-offset="sideOffset"
        :collision-padding="collisionPadding"
        :sticky="sticky"
        :aria-label="ariaLabel"
      >
        <slot />
        <PopoverArrow class="ui-popover__arrow" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.ui-popover{z-index:1200;min-width:180px;padding:7px;border:1px solid #ffffff1a;border-radius:13px;background:rgba(27,31,37,.96);color:#f5f7fa;box-shadow:0 18px 46px #0007;backdrop-filter:blur(22px) saturate(150%);outline:0;transform-origin:var(--reka-popover-content-transform-origin)}
.ui-popover[data-state="open"]{animation:ui-popover-in 180ms cubic-bezier(.16,1,.3,1) both}
.ui-popover[data-state="closed"]{animation:ui-popover-out 120ms cubic-bezier(.4,0,1,1) both}
.ui-popover__arrow{fill:#1b1f25}.ui-popover:focus-visible{box-shadow:0 18px 46px #0007,0 0 0 3px #71aef03d}
@keyframes ui-popover-in{from{opacity:0;filter:blur(3px);transform:scale(.96) translateY(4px)}to{opacity:1;filter:blur(0);transform:scale(1) translateY(0)}}
@keyframes ui-popover-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.98)}}
@media(prefers-reduced-motion:reduce){.ui-popover{animation:none}}
@media(prefers-reduced-transparency:reduce){.ui-popover{background:#1b1f25;backdrop-filter:none}}
</style>
