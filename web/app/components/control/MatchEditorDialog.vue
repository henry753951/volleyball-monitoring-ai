<script setup lang="ts">
import { CalendarClock, MapPin, Trophy } from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { Match, UpdateMatchInput } from '~/lib/coreDomain'
import UiButton from '~/components/ui/Button.vue'

const props = defineProps<{ match: DeepReadonly<Match> | null; open: boolean; pending: boolean; error: Error | null }>()
const emit = defineEmits<{ close: []; save: [input: UpdateMatchInput] }>()
const title = ref('')
const venue = ref('')
const scheduledAt = ref('')
const status = ref('PLANNED')

function localDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

watch(() => props.match, (match) => {
  if (!match) return
  title.value = match.title
  venue.value = match.venue ?? ''
  scheduledAt.value = localDate(match.scheduledAt)
  status.value = match.status
}, { immediate: true })

function save() {
  if (!props.match || !title.value.trim()) return
  emit('save', {
    matchId: props.match.id,
    scheduledAt: scheduledAt.value ? new Date(scheduledAt.value).toISOString() : null,
    status: status.value,
    title: title.value.trim(),
    venue: venue.value.trim() || null,
  })
}
</script>

<template>
  <UiAnimatedModal :open="open" title="編輯場次" description="更新名稱、場地、時間與生命週期" width="compact" @close="emit('close')">
    <form class="match-editor" @submit.prevent="save">
      <label><span>場次名稱</span><div><Trophy :size="15" /><input v-model="title" required maxlength="120" autocomplete="off" /></div></label>
      <label><span>場地</span><div><MapPin :size="15" /><input v-model="venue" maxlength="160" autocomplete="off" placeholder="未設定" /></div></label>
      <label><span>預定時間</span><div><CalendarClock :size="15" /><input v-model="scheduledAt" type="datetime-local" /></div></label>
      <label><span>狀態</span><select v-model="status"><option value="PLANNED">待開始</option><option value="LIVE">進行中</option><option value="FINISHED">已結束</option></select></label>
      <p v-if="error" class="form-error" role="alert">{{ error.message }}</p>
    </form>
    <template #footer><UiButton variant="ghost" :disabled="pending" @click="emit('close')">取消</UiButton><UiButton :disabled="pending || !title.trim()" @click="save">{{ pending ? '儲存中…' : '儲存變更' }}</UiButton></template>
  </UiAnimatedModal>
</template>

<style scoped>
.match-editor{display:grid;gap:14px;padding:18px;overflow:auto}.match-editor label{display:grid;gap:7px;color:#a1a1aa;font-size:.68rem}.match-editor label>div{min-height:40px;display:flex;align-items:center;gap:9px;padding:0 11px;border:1px solid #303036;border-radius:8px;background:#111114;color:#777781}.match-editor input,.match-editor select{width:100%;min-height:40px;border:1px solid #303036;border-radius:8px;outline:0;background:#111114;color:#f4f4f5;font:inherit;padding:0 11px}.match-editor label>div input{min-height:0;padding:0;border:0;background:transparent}.match-editor input:focus,.match-editor select:focus,.match-editor label>div:focus-within{border-color:#a1a1aa}.form-error{margin:0;padding:10px;border:1px solid #7f1d1d;border-radius:8px;background:#2a1012;color:#fecaca;font-size:.68rem}
</style>
