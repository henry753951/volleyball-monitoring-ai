<script setup lang="ts">
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from 'reka-ui'

withDefaults(defineProps<{ horizontal?: boolean }>(), { horizontal: false })
</script>

<template>
  <ScrollAreaRoot class="scroll-area" type="hover">
    <ScrollAreaViewport class="scroll-area__viewport"><slot /></ScrollAreaViewport>
    <ScrollAreaScrollbar class="scroll-area__bar" :class="horizontal ? 'horizontal' : 'vertical'" :orientation="horizontal ? 'horizontal' : 'vertical'">
      <ScrollAreaThumb class="scroll-area__thumb" />
    </ScrollAreaScrollbar>
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>

<style scoped>
.scroll-area { position: relative; min-height: 0; overflow: hidden; }
.scroll-area :deep(.scroll-area__viewport) { position: absolute; inset: 0; width: 100%; height: auto; min-height: 0; border-radius: inherit; }
.scroll-area :deep(.scroll-area__bar) { display: flex; touch-action: none; user-select: none; padding: 2px; transition: opacity 140ms ease; }
.scroll-area :deep(.scroll-area__bar.vertical) { position: absolute; top: 0; right: 0; bottom: 0; width: 9px; }
.scroll-area :deep(.scroll-area__bar.horizontal) { position: absolute; right: 0; bottom: 0; left: 0; height: 9px; flex-direction: column; }
.scroll-area :deep(.scroll-area__thumb) { position: relative; flex: 1; border-radius: 999px; background: #65717d99; }
.scroll-area :deep(.scroll-area__thumb)::before { position: absolute; top: 50%; left: 50%; width: 100%; min-width: 44px; height: 100%; min-height: 44px; transform: translate(-50%, -50%); content: ""; }
</style>
