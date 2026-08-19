<script setup lang="ts">
import { ChevronRight, RotateCcw } from 'lucide-vue-next'
import {
  coachRallyContactCount,
  coachRallyPathCount,
  coachRallyTrackCount,
} from '~/utils/coachPresentation'
import { deriveSetDisplayProjection } from '~/utils/setDisplayProjection'

const route = useRoute()
const matchId = computed(() => String(route.params.matchId))
const coach = useCoachMatchState(matchId)
const match = computed(() => coach.data.value?.match ?? null)
const selectedSet = ref('all')
const teamById = computed(() => new Map((match.value?.teams ?? []).map(team => [team.id, team])))
const completedRallies = computed(() =>
  (match.value?.rallies ?? []).filter(rally => rally.submission.analysis?.status === 'completed'),
)
const setProjection = computed(() =>
  deriveSetDisplayProjection(
    (match.value?.sets ?? []).map(set => ({
      id: set.id,
      set_number: set.set_number,
      winning_team_id: set.winning_team_id,
      status: set.status,
    })),
  ),
)
const displaySetNumberFor = (setNumber: number) =>
  setProjection.value.rawToEffective.get(setNumber) ?? setNumber
const setTabs = computed(() => [
  { value: 'all', label: '全部', count: completedRallies.value.length },
  ...[...new Set((match.value?.sets ?? []).map(set => displaySetNumberFor(set.set_number)))].map(
    setNumber => ({
      value: String(setNumber),
      label: `第 ${setNumber} 局`,
      count: completedRallies.value.filter(
        rally => displaySetNumberFor(rally.set_number) === setNumber,
      ).length,
    }),
  ),
])
const rallies = computed(() =>
  completedRallies.value.filter(
    rally =>
      selectedSet.value === 'all' ||
      displaySetNumberFor(rally.set_number) === Number(selectedSet.value),
  ),
)

function outcomeLabel(rally: (typeof rallies.value)[number]) {
  if (rally.submission.score_resolution === 'unknown') return '結果待確認'
  return teamById.value.get(rally.submission.scoring_team_id ?? '')?.name ?? '未計分'
}

function durationLabel(value?: string | null) {
  if (!value) return '—'
  const milliseconds = Number(BigInt(value) / 1_000n)
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} 秒`
}

function submittedTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="rally-browser">
    <header class="rally-browser__bar">
      <UiScrollArea horizontal class="rally-browser__set-scroll">
        <UiTabs v-model="selectedSet" :options="setTabs" aria-label="局數" />
      </UiScrollArea>
      <p>
        <strong>{{ rallies.length }}</strong
        ><span>個已完成回合</span>
      </p>
    </header>

    <div v-if="coach.pending.value" class="rally-list rally-list--loading" aria-busy="true">
      <i v-for="n in 4" :key="n" />
    </div>
    <div v-else-if="!rallies.length" class="rally-empty">
      <RotateCcw :size="22" /><strong>目前沒有已完成的回合</strong
      ><span>分析完成後會自動出現在這裡。</span>
    </div>
    <UiScrollArea v-else class="rally-list-scroll">
      <ol class="rally-list">
        <li v-for="rally in rallies" :key="rally.id">
          <NuxtLink :to="`/matches/${matchId}/replay/${rally.id}`">
            <span
              class="rally-state"
              :class="{ mapped: rally.submission.analysis?.identity_mapping_completed }"
            />
            <div class="rally-primary">
              <strong>回合 {{ rally.ordinal }}</strong>
              <small
                >第 {{ displaySetNumberFor(rally.set_number) }} 局 ·
                {{ submittedTime(rally.submission.submitted_at) }}</small
              >
            </div>
            <div class="rally-result">
              <small>結果</small><strong>{{ outcomeLabel(rally) }}</strong>
            </div>
            <div class="rally-measure">
              <small>時間</small
              ><strong>{{ durationLabel(rally.submission.clip?.duration_us) }}</strong>
            </div>
            <div class="rally-analysis">
              <small>分析</small>
              <strong>{{ coachRallyContactCount(rally) }} 擊球</strong>
              <span
                >{{ coachRallyPathCount(rally) }} 球路 ·
                {{ coachRallyTrackCount(rally) }} 軌跡</span
              >
            </div>
            <ChevronRight :size="19" />
          </NuxtLink>
        </li>
      </ol>
    </UiScrollArea>
  </section>
</template>

<style scoped>
.rally-browser {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: 62px minmax(0, 1fr);
  overflow: hidden;
  background: #f7f8fa;
}
.rally-browser__bar {
  position: relative;
  z-index: 3;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 24px;
  border-bottom: 1px solid #dfe4e9;
  background: rgba(247, 248, 250, 0.94);
  backdrop-filter: blur(18px);
}
.rally-browser__bar > p {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin: 0;
  color: #78828d;
  font-size: 0.63rem;
}
.rally-browser__bar > p strong {
  color: #232930;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}
.rally-browser__set-scroll {
  width: min(100%, 760px);
  height: 48px;
  display: flex;
  align-items: center;
}
.rally-list-scroll {
  height: 100%;
  min-height: 0;
}
.rally-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rally-list li {
  border-bottom: 1px solid #e1e5e9;
}
.rally-list li a {
  min-height: 82px;
  display: grid;
  grid-template-columns:
    8px minmax(170px, 0.9fr) minmax(150px, 0.8fr) minmax(100px, 0.42fr) minmax(180px, 0.72fr)
    20px;
  align-items: center;
  gap: 18px;
  padding: 0 24px;
  color: inherit;
  text-decoration: none;
  transition: background-color 130ms ease;
}
.rally-list li a:hover {
  background: #fff;
}
.rally-list li a:active {
  background: #edf3fa;
}
.rally-list li a:focus-visible {
  outline: 3px solid #0670df38;
  outline-offset: -3px;
}
.rally-state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2f79d7;
  box-shadow: 0 0 0 4px #2f79d712;
}
.rally-state.mapped {
  background: #278a62;
  box-shadow: 0 0 0 4px #278a6214;
}
.rally-primary,
.rally-result,
.rally-measure,
.rally-analysis {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.rally-primary strong {
  font-size: 0.88rem;
  letter-spacing: -0.01em;
}
.rally-primary small,
.rally-result small,
.rally-measure small,
.rally-analysis small,
.rally-analysis span {
  color: #7c858f;
  font-size: 0.59rem;
}
.rally-result strong,
.rally-measure strong,
.rally-analysis strong {
  overflow: hidden;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rally-measure strong,
.rally-analysis strong {
  font-variant-numeric: tabular-nums;
}
.rally-list li svg {
  color: #929aa4;
}
.rally-list--loading {
  display: grid;
}
.rally-list--loading i {
  height: 82px;
  border-bottom: 1px solid #e2e6ea;
  background: linear-gradient(100deg, #edf0f3 20%, #e3e7eb 40%, #edf0f3 60%);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.rally-empty {
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 7px;
  color: #737c87;
}
.rally-empty strong {
  color: #313840;
  font-size: 0.8rem;
}
.rally-empty span {
  font-size: 0.68rem;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@media (max-width: 760px) {
  .rally-browser__bar {
    padding-inline: 14px;
  }
  .rally-browser__bar > p span {
    display: none;
  }
  .rally-list li a {
    grid-template-columns: 8px minmax(118px, 0.9fr) minmax(100px, 0.8fr) minmax(120px, 0.7fr) 18px;
    gap: 10px;
    padding: 0 14px;
  }
  .rally-measure {
    display: none;
  }
  .rally-analysis span {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rally-list--loading i {
    animation: none;
  }
  .rally-list li a {
    transition: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .rally-browser__bar {
    background: #f7f8fa;
    backdrop-filter: none;
  }
}
</style>
