<script setup lang="ts">
import { HoverCardArrow, HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui'

withDefaults(defineProps<{
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  collisionPadding?: number
  openDelay?: number
  closeDelay?: number
  disabled?: boolean
  contentClass?: string
}>(), {
  side: 'left',
  align: 'start',
  sideOffset: 10,
  collisionPadding: 12,
  openDelay: 180,
  closeDelay: 100,
  disabled: false,
  contentClass: '',
})
</script>

<template>
  <HoverCardRoot :open-delay="openDelay" :close-delay="closeDelay">
    <HoverCardTrigger as-child><slot name="trigger" /></HoverCardTrigger>
    <HoverCardPortal v-if="!disabled">
      <HoverCardContent
        :class="['ui-hover-card', contentClass]"
        :side="side"
        :align="align"
        :side-offset="sideOffset"
        :collision-padding="collisionPadding"
      >
        <slot />
        <HoverCardArrow class="ui-hover-card__arrow" />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>

<style>
.ui-hover-card{z-index:1350;width:min(250px,calc(100vw - 24px));overflow:hidden;border:1px solid #3f3f46;border-radius:11px;background:#111114;color:#fafafa;box-shadow:0 18px 48px #000b;transform-origin:var(--reka-hover-card-content-transform-origin)}
.ui-hover-card[data-side="left"]{--ui-hover-card-offset:6px}.ui-hover-card[data-side="right"]{--ui-hover-card-offset:-6px}
.ui-hover-card[data-state="open"]{animation:ui-hover-card-in 190ms cubic-bezier(.16,1,.3,1) both}
.ui-hover-card[data-state="closed"]{animation:ui-hover-card-out 110ms cubic-bezier(.4,0,1,1) both}
.ui-hover-card__arrow{fill:#111114}
@keyframes ui-hover-card-in{from{opacity:0;filter:blur(3px);transform:translateX(var(--ui-hover-card-offset,0)) scale(.97)}to{opacity:1;filter:blur(0);transform:translateX(0) scale(1)}}
@keyframes ui-hover-card-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.98)}}
@media(max-width:720px){.ui-hover-card{display:none}}
@media(prefers-reduced-motion:reduce){.ui-hover-card{animation:none}}
</style>
