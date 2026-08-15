<script setup lang="ts">
import { ArrowLeft, ArrowRight, Check } from 'lucide-vue-next'
import type { CreateMatchSetupInput, RosterInput } from '../lib/coreDomain'
import type { CreateMatchWithMediaInput, MatchMediaSourceDraft } from '../lib/mediaSourceClient'
import { validateMatchSetup } from '../utils/matchSetup'
import UiButton from '~/components/ui/Button.vue'

const props = withDefaults(
  defineProps<{ pending: boolean; error: Error | null; compact?: boolean }>(),
  { compact: false },
)
const emit = defineEmits<{ submit: [input: CreateMatchWithMediaInput]; cancel: [] }>()

const title = ref('')
const venue = ref('')
const scheduledAt = ref('')
const firstTeam = reactive({ name: '', shortName: '', roster: [] as RosterInput[] })
const secondTeam = reactive({ name: '', shortName: '', roster: [] as RosterInput[] })
const validationErrors = ref<string[]>([])
const step = ref<1 | 2>(1)
const media = ref<MatchMediaSourceDraft>({ kind: 'youtube', label: '', url: '' })

function addRosterRow(team: typeof firstTeam) {
  team.roster.push({ name: '', jerseyNumber: '', position: 'UNSPECIFIED' })
}

function removeRosterRow(team: typeof firstTeam, index: number) {
  team.roster.splice(index, 1)
}

function rosterInput(rows: readonly RosterInput[]): RosterInput[] {
  return rows
    .map(row => ({
      name: row.name.trim(),
      jerseyNumber: row.jerseyNumber.trim(),
      position: row.position,
    }))
    .filter(row => row.name || row.jerseyNumber || row.position !== 'UNSPECIFIED')
}

function matchInput(): CreateMatchSetupInput {
  return {
    title: title.value.trim(),
    venue: venue.value.trim() || undefined,
    scheduledAt: scheduledAt.value ? new Date(scheduledAt.value).toISOString() : undefined,
    teams: [
      {
        name: firstTeam.name.trim(),
        shortName: firstTeam.shortName.trim(),
        roster: rosterInput(firstTeam.roster),
      },
      {
        name: secondTeam.name.trim(),
        shortName: secondTeam.shortName.trim(),
        roster: rosterInput(secondTeam.roster),
      },
    ],
  }
}

function validYoutubeUrl(value: string) {
  try {
    return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(
      new URL(value).hostname.toLowerCase(),
    )
  } catch {
    return false
  }
}

function submit() {
  const input = matchInput()
  validationErrors.value = validateMatchSetup(input)
  if (validationErrors.value.length) {
    step.value = 1
    return
  }
  if (step.value === 1) {
    step.value = 2
    return
  }
  if (media.value.kind === 'youtube' && !validYoutubeUrl(media.value.url)) {
    validationErrors.value = ['請輸入有效的 YouTube 影片或直播網址。']
    return
  }
  if (media.value.kind === 'local_mp4' && !media.value.file.name) {
    validationErrors.value = ['請選擇要上傳的 MP4 檔案。']
    return
  }
  emit('submit', { match: input, media: media.value })
}
</script>

<template>
  <form
    class="match-setup"
    :class="{ compact: props.compact }"
    :aria-busy="props.pending"
    @submit.prevent="submit"
  >
    <div class="setup-progress" aria-label="建立進度">
      <span :class="{ active: step === 1, done: step === 2 }"
        ><i><Check v-if="step === 2" :size="12" /><template v-else>1</template></i
        ><b>場次與隊伍</b></span
      >
      <em />
      <span :class="{ active: step === 2 }"><i>2</i><b>影音來源</b></span>
    </div>

    <template v-if="step === 1">
      <div class="match-fields">
        <label class="block md:col-span-1"
          ><span class="field-label">場次名稱</span
          ><input
            v-model="title"
            class="field"
            required
            maxlength="120"
            autocomplete="off"
            placeholder="例如：大專盃準決賽"
        /></label>
        <label class="block"
          ><span class="field-label">場地（選填）</span
          ><input
            v-model="venue"
            class="field"
            maxlength="160"
            autocomplete="off"
            placeholder="場館名稱"
        /></label>
        <label class="block"
          ><span class="field-label">預定時間（選填）</span
          ><input v-model="scheduledAt" class="field" type="datetime-local" autocomplete="off"
        /></label>
      </div>
      <div class="team-grid">
        <TeamSetupCard
          v-model="firstTeam"
          label="參賽隊伍 1"
          @add="addRosterRow(firstTeam)"
          @remove="removeRosterRow(firstTeam, $event)"
        />
        <TeamSetupCard
          v-model="secondTeam"
          label="參賽隊伍 2"
          @add="addRosterRow(secondTeam)"
          @remove="removeRosterRow(secondTeam, $event)"
        />
      </div>
    </template>

    <div v-else class="media-step">
      <header>
        <span>影音來源</span>
        <h2>連接這場比賽的畫面</h2>
        <p>YouTube 影片、直播與本機 MP4 都會由伺服器建立完整 DVR 與逐幀索引。</p>
      </header>
      <MediaSourcePicker v-model="media" />
    </div>

    <div
      v-if="validationErrors.length || props.error"
      class="match-errors"
      role="alert"
      aria-live="polite"
    >
      <p class="font-semibold">建立前需要處理以下問題</p>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li v-for="message in validationErrors" :key="message">{{ message }}</li>
      </ul>
      <p v-if="props.error" class="mt-2">{{ props.error.message }}</p>
    </div>

    <div class="match-actions">
      <UiButton type="button" variant="ghost" @click="emit('cancel')">取消</UiButton>
      <UiButton
        v-if="step === 2"
        type="button"
        variant="ghost"
        :disabled="props.pending"
        @click="step = 1"
        ><ArrowLeft :size="15" />返回</UiButton
      >
      <UiButton type="submit" :disabled="props.pending">
        {{ props.pending ? '建立中…' : step === 1 ? '下一步' : '建立場次' }}
        <ArrowRight v-if="!props.pending && step === 1" :size="15" />
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.match-setup {
  display: grid;
  gap: 14px;
  padding: 14px;
  overflow: auto;
  color: #fafafa;
}
.setup-progress {
  display: grid;
  grid-template-columns: auto minmax(30px, 100px) auto;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-block: 2px;
}
.setup-progress span {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #71767c;
  font-size: 0.62rem;
}
.setup-progress i {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1px solid #383d43;
  border-radius: 50%;
  font-style: normal;
  font-variant-numeric: tabular-nums;
}
.setup-progress span.active {
  color: #f4f5f5;
}
.setup-progress span.active i,
.setup-progress span.done i {
  border-color: #d9dcdf;
  background: #e7e9eb;
  color: #111417;
}
.setup-progress em {
  height: 1px;
  background: #30353a;
}
.match-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  padding: 14px;
  border-radius: 10px;
  background: #111113;
}
.match-fields :deep(.field) {
  border: 1px solid #27272a;
  background: #18181b;
  color: #fafafa;
}
.match-fields :deep(.field:focus) {
  border-color: #71717a;
  box-shadow: 0 0 0 2px #fafafa24;
}
.team-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.media-step {
  display: grid;
  gap: 17px;
  min-height: 390px;
  padding: 18px;
  border: 1px solid #292e33;
  border-radius: 13px;
  background: #0f1215;
}
.media-step header {
  display: grid;
  gap: 5px;
}
.media-step header span {
  color: #8c939a;
  font-size: 0.58rem;
  font-weight: 750;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.media-step h2 {
  margin: 0;
  font-size: 1rem;
  letter-spacing: -0.025em;
}
.media-step p {
  max-width: 62ch;
  margin: 0;
  color: #7e858c;
  font-size: 0.64rem;
  line-height: 1.55;
}
.match-errors {
  padding: 12px;
  border-radius: 9px;
  background: #2b1114;
  color: #fca5a5;
  font-size: 0.72rem;
}
.match-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.match-actions :deep(button) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.compact {
  max-height: calc(100dvh - 78px);
}
@media (max-width: 760px) {
  .match-fields,
  .team-grid {
    grid-template-columns: 1fr;
  }
  .setup-progress b {
    display: none;
  }
}
</style>
