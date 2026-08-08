<script setup lang="ts">
import { SplitterGroup } from 'reka-ui'
withDefaults(defineProps<{ direction?: 'horizontal' | 'vertical'; id?: string }>(), { direction: 'horizontal', id: 'resizable-panel-group' })
</script>
<template><SplitterGroup :id="id" :direction="direction" class="ui-resizable-group"><slot /></SplitterGroup></template>
<style scoped>.ui-resizable-group{display:flex;width:100%;height:100%;overflow:hidden}.ui-resizable-group[data-orientation="vertical"]{flex-direction:column}</style>
