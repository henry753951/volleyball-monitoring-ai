<script setup lang="ts">
import { Check, ImageOff, LoaderCircle, ScanText, Shirt, WandSparkles } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import type { ReidJerseySuggestionItem, ReidJerseySuggestionRun } from '~/lib/coachDomain'
import UiButton from './ui/Button.vue'
import UiHoverCard from './ui/HoverCard.vue'

const props = defineProps<{
  open: boolean
  run: ReidJerseySuggestionRun
  applyingIds: string[]
}>()
const emit = defineEmits<{ close: []; apply: [suggestionIds: string[]] }>()
const selectedIds = ref<string[]>([])

const applicableItems = computed(() =>
  props.run.items.filter(
    item =>
      item.status === 'COMPLETED' &&
      item.changed &&
      item.suggested_roster_entry_id &&
      !item.applied_at,
  ),
)
const selectedCount = computed(() => selectedIds.value.length)
const resolvedCount = computed(
  () => props.run.items.filter(item => item.suggested_roster_entry_id).length,
)
const unresolvedCount = computed(
  () => props.run.items.filter(item => !item.suggested_roster_entry_id).length,
)
const applying = computed(() => props.applyingIds.length > 0)

watch(
  () => [props.run.run_id, ...props.run.items.map(item => item.applied_at ?? '')],
  () => {
    selectedIds.value = applicableItems.value.map(item => item.suggestion_id)
  },
  { immediate: true },
)

function canSelect(item: ReidJerseySuggestionItem) {
  return Boolean(
    item.status === 'COMPLETED' &&
    item.changed &&
    item.suggested_roster_entry_id &&
    !item.applied_at,
  )
}

function setSelected(suggestionId: string, selected: boolean) {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, suggestionId])]
    : selectedIds.value.filter(id => id !== suggestionId)
}

function resultLabel(item: ReidJerseySuggestionItem) {
  if (item.status === 'FAILED') return '辨識失敗'
  if (!item.suggested_jersey_number) return '未辨識到背號'
  if (!item.suggested_roster_entry_id) return `#${item.suggested_jersey_number} · 名單無唯一對應`
  return `#${item.suggested_jersey_number} ${item.suggested_player_name ?? ''}`.trim()
}
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="背號感知差異"
    description="模型只提出建議；未勾選、無唯一名單對應或辨識失敗的 Local ID 都不會變更。"
    width="wide"
    height="tall"
    @close="emit('close')"
  >
    <div class="jersey-review">
      <div class="jersey-review__summary">
        <span
          ><ScanText :size="15" /><b>{{ run.items.length }}</b> Local</span
        >
        <span
          ><Check :size="15" /><b>{{ resolvedCount }}</b> 可對照名單</span
        >
        <span
          ><ImageOff :size="15" /><b>{{ unresolvedCount }}</b> 保持原狀</span
        >
        <small>{{ run.model_namespace || 'OpenAI-compatible vision API' }}</small>
      </div>

      <div v-if="!run.items.length" class="jersey-review__empty">
        <Shirt :size="24" />這個片段沒有可檢查的 Local ID
      </div>
      <div v-else class="jersey-review__list">
        <UiHoverCard
          v-for="item in run.items"
          :key="item.suggestion_id"
          side="left"
          align="start"
          :disabled="!item.preview_url && !item.montage_url"
          content-class="jersey-evidence-card"
        >
          <template #trigger>
            <label
              class="jersey-diff"
              :class="{
                selectable: canSelect(item),
                selected: selectedIds.includes(item.suggestion_id),
                applied: item.applied_at,
              }"
            >
              <input
                type="checkbox"
                :checked="selectedIds.includes(item.suggestion_id)"
                :disabled="!canSelect(item) || applying"
                :aria-label="`套用 Local ${item.track_id} 的背號建議`"
                @change="
                  setSelected(item.suggestion_id, ($event.target as HTMLInputElement).checked)
                "
              />
              <span class="jersey-diff__local">
                <strong>Local {{ String(item.track_id).padStart(2, '0') }}</strong>
                <small>{{ item.gid_label || 'Active unbound GID' }}</small>
              </span>
              <span class="jersey-diff__identity current">
                <small>目前</small>
                <b>
                  {{
                    item.current_roster_entry_id
                      ? `#${item.current_jersey_number} ${item.current_player_name}`
                      : '未指派球員'
                  }}
                </b>
              </span>
              <span class="jersey-diff__arrow" aria-hidden="true">→</span>
              <span class="jersey-diff__identity suggestion">
                <small>建議</small>
                <b>{{ resultLabel(item) }}</b>
                <em v-if="item.confidence != null">{{ Math.round(item.confidence * 100) }}%</em>
              </span>
              <span class="jersey-diff__state">
                <LoaderCircle
                  v-if="applyingIds.includes(item.suggestion_id)"
                  class="spin"
                  :size="15"
                />
                <Check v-else-if="item.applied_at" :size="15" />
                <WandSparkles v-else-if="canSelect(item)" :size="15" />
                <ImageOff v-else :size="15" />
              </span>
            </label>
          </template>
          <div class="jersey-evidence">
            <img
              v-if="item.preview_url"
              :src="item.preview_url"
              :alt="`Local ${item.track_id} 動態預覽`"
            />
            <img
              v-if="item.montage_url"
              :src="item.montage_url"
              :alt="`Local ${item.track_id} 背號候選影格拼圖`"
            />
            <p>
              Hover 預覽 · 從高品質軀幹候選中隨機取
              {{ item.selected_frame_indices.length }} 張
            </p>
          </div>
        </UiHoverCard>
      </div>
    </div>
    <template #footer>
      <span class="jersey-review__selection">
        已選 {{ selectedCount }} / {{ applicableItems.length }} 筆可套用差異
      </span>
      <UiButton variant="ghost" :disabled="applying" @click="emit('close')">稍後處理</UiButton>
      <UiButton :disabled="!selectedCount || applying" @click="emit('apply', selectedIds)">
        <LoaderCircle v-if="applying" class="spin" :size="15" />
        {{ applying ? '正在套用…' : `套用選取的 ${selectedCount} 筆` }}
      </UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.jersey-review {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  background: #0d1013;
}
.jersey-review__summary {
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 9px 16px;
  border-bottom: 1px solid #2c3338;
  background: #14191d;
}
.jersey-review__summary span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #aab5bd;
  font-size: 0.65rem;
}
.jersey-review__summary b {
  color: #f1f5f7;
  font-variant-numeric: tabular-nums;
}
.jersey-review__summary small {
  overflow: hidden;
  margin-left: auto;
  color: #7f8b94;
  font:
    0.56rem ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jersey-review__list {
  overflow-y: auto;
  overscroll-behavior: contain;
}
.jersey-diff {
  min-height: 70px;
  display: grid;
  grid-template-columns: 24px 116px minmax(150px, 1fr) 22px minmax(170px, 1fr) 28px;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid #242b30;
  background: #11161a;
  color: #dce3e8;
  transition: background-color 140ms ease-out;
}
.jersey-diff.selectable {
  cursor: pointer;
}
.jersey-diff.selectable:hover,
.jersey-diff.selected {
  background: #182126;
}
.jersey-diff.selected {
  box-shadow: inset 3px 0 #5eb58a;
}
.jersey-diff.applied {
  color: #8fd5ae;
}
.jersey-diff input {
  width: 15px;
  height: 15px;
  accent-color: #5eb58a;
}
.jersey-diff__local,
.jersey-diff__identity {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.jersey-diff__local strong {
  font:
    700 0.68rem ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.jersey-diff__local small,
.jersey-diff__identity small {
  overflow: hidden;
  color: #7f8b94;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jersey-diff__identity b {
  overflow: hidden;
  font-size: 0.66rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jersey-diff__identity.suggestion b {
  color: #b9e8cf;
}
.jersey-diff__identity em {
  color: #7fbd9d;
  font-size: 0.52rem;
  font-style: normal;
}
.jersey-diff__arrow {
  color: #65717a;
  text-align: center;
}
.jersey-diff__state {
  display: grid;
  place-items: center;
  color: #6ab98e;
}
.jersey-review__empty {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  color: #87929b;
  font-size: 0.7rem;
}
.jersey-review__selection {
  margin-right: auto;
  color: #a7b2ba;
  font-size: 0.64rem;
}
.spin {
  animation: jersey-spin 0.8s linear infinite;
}
@keyframes jersey-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 760px) {
  .jersey-diff {
    grid-template-columns: 22px 90px minmax(0, 1fr) 24px;
  }
  .jersey-diff__identity.current,
  .jersey-diff__arrow {
    display: none;
  }
  .jersey-review__summary {
    gap: 10px;
  }
  .jersey-review__summary small {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .jersey-diff,
  .spin {
    animation: none;
    transition: none;
  }
}
</style>

<style>
.ui-hover-card.jersey-evidence-card {
  width: min(420px, calc(100vw - 24px));
}
.jersey-evidence {
  display: grid;
  gap: 1px;
  padding: 6px;
  background: #090b0d;
}
.jersey-evidence img {
  width: 100%;
  max-height: 240px;
  display: block;
  object-fit: contain;
  border-radius: 6px;
  background: #000;
}
.jersey-evidence p {
  margin: 5px 3px 2px;
  color: #98a4ad;
  font-size: 0.56rem;
  line-height: 1.5;
}
</style>
