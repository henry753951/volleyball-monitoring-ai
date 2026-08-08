<script setup lang="ts">
import { SplitterResizeHandle } from 'reka-ui'
withDefaults(defineProps<{ id?: string; label?: string }>(), { id: 'resizable-handle', label: '調整面板寬度' })
</script>
<template><SplitterResizeHandle :id="id" class="ui-resizable-handle" :aria-label="label"><span /></SplitterResizeHandle></template>
<style scoped>.ui-resizable-handle{position:relative;z-index:5;width:5px;flex:0 0 5px;border:0;background:#18181b;cursor:col-resize}.ui-resizable-handle::after{position:absolute;inset:0 -3px;content:""}.ui-resizable-handle span{position:absolute;left:2px;top:calc(50% - 18px);width:1px;height:36px;background:#52525b}.ui-resizable-handle[data-resize-handle-active]{background:#27272a}</style>
