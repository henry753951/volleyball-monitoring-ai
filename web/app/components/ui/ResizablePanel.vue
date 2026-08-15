<script setup lang="ts">
import { SplitterPanel } from 'reka-ui'
defineProps<{ defaultSize?: number; minSize?: number; maxSize?: number; id?: string }>()
</script>
<template>
  <SplitterPanel
    :id="id"
    :default-size="defaultSize"
    :min-size="minSize"
    :max-size="maxSize"
    class="ui-resizable-panel"
    ><slot
  /></SplitterPanel>
</template>
<style scoped>
.ui-resizable-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
