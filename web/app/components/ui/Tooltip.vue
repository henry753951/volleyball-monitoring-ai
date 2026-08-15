<script setup lang="ts">
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui'

withDefaults(
  defineProps<{ content: string; side?: 'top' | 'right' | 'bottom' | 'left'; delay?: number }>(),
  { side: 'top', delay: 350 },
)
</script>

<template>
  <TooltipProvider :delay-duration="delay">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal
        ><TooltipContent class="ui-tooltip" :side="side" :side-offset="7"
          ><slot name="content">{{ content }}</slot
          ><TooltipArrow class="ui-tooltip__arrow" /></TooltipContent
      ></TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style>
.ui-tooltip {
  z-index: 1200;
  max-width: 260px;
  padding: 0.45rem 0.62rem;
  border: 1px solid #3f3f46;
  border-radius: 0.5rem;
  background: #18181b;
  color: #fafafa;
  box-shadow: 0 12px 36px #0009;
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.01em;
  animation: tooltip-in 140ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ui-tooltip__arrow {
  fill: #18181b;
}
@keyframes tooltip-in {
  from {
    opacity: 0;
    transform: translateY(3px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ui-tooltip {
    animation: none;
  }
}
</style>
