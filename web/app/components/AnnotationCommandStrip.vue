<script setup lang="ts">
import { ANNOTATION_COMMANDS, formatBindingForDisplay, type AnnotationAction } from '~/utils/annotationHotkeys'
const props = defineProps<{ bindings: Record<string, string>; state: 'IDLE'|'OPEN'|'READY'|'SUBMITTED'; canMark: boolean; lastKeyPoint: boolean }>()
const emit = defineEmits<{ action: [AnnotationAction] }>()
function reason(action: AnnotationAction) { if (action === 'service' && !props.canMark) return '游標尚未由伺服器確認'; if (action === 'contact' && props.state !== 'OPEN') return '尚未開啟回合'; if (action.startsWith('close_') && !props.lastKeyPoint) return '沒有伺服器確認的最後 key point'; if (action === 'submit' && props.state !== 'READY') return '提交狀態尚未就緒'; return '' }
</script>
<template><div class="command-strip" aria-label="Annotation commands"><button v-for="command in ANNOTATION_COMMANDS" :key="command.action" type="button" :disabled="Boolean(reason(command.action))" :title="reason(command.action) || '可用'" @click="emit('action', command.action)"><strong>{{ formatBindingForDisplay(bindings[command.action]) }} {{ command.label }}</strong><small>{{ reason(command.action) || '可用' }}</small></button></div></template>
