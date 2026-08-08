<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'

withDefaults(defineProps<{ content: string; side?: 'top' | 'right' | 'bottom' | 'left'; delay?: number }>(), { side: 'top', delay: 350 })
</script>

<template>
  <TooltipProvider :delay-duration="delay">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal><TooltipContent class="ui-tooltip" :side="side" :side-offset="7"><slot name="content">{{ content }}</slot><TooltipArrow class="ui-tooltip__arrow" /></TooltipContent></TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style scoped>
.ui-tooltip{z-index:1200;max-width:260px;padding:.38rem .55rem;border:1px solid #3f3f46;border-radius:.42rem;background:#18181b;color:#fafafa;box-shadow:0 12px 36px #0009;font-size:.66rem;line-height:1.35;animation:tooltip-in 100ms ease-out}.ui-tooltip__arrow{fill:#18181b}@keyframes tooltip-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.ui-tooltip{animation:none}}
</style>
