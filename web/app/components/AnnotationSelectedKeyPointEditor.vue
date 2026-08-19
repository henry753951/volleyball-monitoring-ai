<script setup lang="ts">
import {
  resultForBallEventChoice,
  type BallEventKind,
  type BallEventResultChoice,
  type BallEventValue,
  type ServeStyle,
} from '@volleyball-monitoring/contracts'
import { Check, ChevronDown, LocateFixed, Pin, UserRoundCheck } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/Button.vue'
import UiPopover from '~/components/ui/Popover.vue'
import {
  BALL_EVENT_TONE_COLORS,
  ballEventKindLabel,
  ballEventTone,
} from '~/utils/annotationBallEventPresentation'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'

const props = withDefaults(
  defineProps<{
    selectedBallEvent?: BallEventValue | null
    previousBallEvent?: BallEventValue | null
    selectedOrdinal?: number
    selectedActorId?: string | null
    actorOptions?: ReadonlyArray<{ id: string; label: string }>
    positionMode?: 'follow' | 'pinned'
  }>(),
  {
    selectedBallEvent: null,
    previousBallEvent: null,
    selectedOrdinal: 1,
    selectedActorId: null,
    actorOptions: () => [],
    positionMode: 'follow',
  },
)
const emit = defineEmits<{
  'update:positionMode': [mode: 'follow' | 'pinned']
}>()

const workstation = useAnnotationWorkstationService()
const kindOpen = ref(false)
const actorOpen = ref(false)
const tone = computed(() => ballEventTone(props.selectedBallEvent))
const accent = computed(() => BALL_EVENT_TONE_COLORS[tone.value])
const selectedActorLabel = computed(
  () =>
    props.actorOptions.find(option => option.id === props.selectedActorId)?.label ?? '未指定球員',
)
const kindOptions = computed<ReadonlyArray<{ kind: BallEventKind; label: string }>>(() => {
  if (props.selectedOrdinal === 1) return [{ kind: 'SERVE', label: '發球' }]
  return [
    { kind: 'CONTACT', label: 'HIT' },
    { kind: 'RECEIVE', label: '接球' },
    ...(props.selectedOrdinal >= 3 ? [{ kind: 'SPIKE' as const, label: '殺球' }] : []),
  ]
})
const resultEnabled = computed(() =>
  Boolean(props.selectedBallEvent && props.selectedBallEvent.kind !== 'CONTACT'),
)
const eventEditState = computed(() => workstation.actions.state('mark.set-event').value)

function eventWith(patch: Partial<BallEventValue>): BallEventValue | null {
  if (!props.selectedBallEvent) return null
  const kind = patch.kind ?? props.selectedBallEvent.kind
  const hasResult = Object.prototype.hasOwnProperty.call(patch, 'result')
  const hasServeStyle = Object.prototype.hasOwnProperty.call(patch, 'serve_style')
  return {
    ...props.selectedBallEvent,
    ...patch,
    kind,
    result:
      patch.kind && patch.kind !== props.selectedBallEvent.kind
        ? null
        : hasResult
          ? (patch.result ?? null)
          : props.selectedBallEvent.result,
    serve_style:
      kind === 'SERVE'
        ? hasServeStyle
          ? (patch.serve_style ?? 'JUMP')
          : (props.selectedBallEvent.serve_style ?? 'JUMP')
        : null,
  }
}

function chooseKind(kind: BallEventKind) {
  const event = eventWith({ kind })
  if (event) void workstation.actions.execute('mark.set-event', event)
  kindOpen.value = false
}

function chooseResult(choice: BallEventResultChoice) {
  const current = props.selectedBallEvent
  if (!current || current.kind === 'CONTACT') return
  const result = resultForBallEventChoice(current.kind, choice)
  const event = eventWith({ result: current.result === result ? null : result })
  if (event) void workstation.actions.execute('mark.set-event', event)
}

function chooseServeStyle(serveStyle: ServeStyle) {
  const event = eventWith({ serve_style: serveStyle })
  if (event) void workstation.actions.execute('mark.set-event', event)
}

function resultSelected(choice: BallEventResultChoice) {
  const event = props.selectedBallEvent
  return Boolean(event && event.result === resultForBallEventChoice(event.kind, choice))
}

function chooseActor(actorRosterEntryId: string | null) {
  void workstation.actions.execute('mark.set-actor', actorRosterEntryId)
  actorOpen.value = false
}
</script>

<template>
  <div
    class="selected-point-editor"
    :class="{ pinned: positionMode === 'pinned' }"
    data-annotation-hotkey-surface="workstation"
    :style="{ '--point-accent': accent }"
  >
    <div class="point-editor-position" role="group" aria-label="編輯器位置">
      <button
        type="button"
        :class="{ active: positionMode === 'follow' }"
        :aria-pressed="positionMode === 'follow'"
        title="跟隨選取球點"
        @click="emit('update:positionMode', 'follow')"
      >
        <LocateFixed :size="13" />
        <span>跟隨</span>
      </button>
      <button
        type="button"
        :class="{ active: positionMode === 'pinned' }"
        :aria-pressed="positionMode === 'pinned'"
        title="固定在時間軸下方"
        @click="emit('update:positionMode', 'pinned')"
      >
        <Pin :size="13" />
        <span>釘選</span>
      </button>
    </div>
    <i aria-hidden="true" />
    <UiPopover
      :open="kindOpen"
      side="bottom"
      align="start"
      content-class="ball-event-kind-popover"
      aria-label="修改球種"
      @update:open="kindOpen = $event"
    >
      <template #trigger>
        <UiButton
          variant="secondary"
          class="point-detail-button event-kind"
          :disabled="!eventEditState.enabled"
          :title="eventEditState.reason || '修改球種'"
        >
          <span class="event-swatch" />
          <span>{{
            ballEventKindLabel(selectedBallEvent, { previousEvent: previousBallEvent })
          }}</span>
          <ChevronDown :size="12" />
        </UiButton>
      </template>
      <div class="point-detail-options">
        <strong>球種</strong>
        <button
          v-for="option in kindOptions"
          :key="option.kind"
          type="button"
          :aria-pressed="selectedBallEvent?.kind === option.kind"
          @click="chooseKind(option.kind)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="selectedBallEvent?.kind === option.kind" :size="14" />
        </button>
      </div>
    </UiPopover>

    <div v-if="selectedBallEvent?.kind === 'SERVE'" class="serve-style" aria-label="發球方式">
      <button
        v-for="option in [
          ['JUMP', '跳發'],
          ['STANDING', '站發'],
        ] as const"
        :key="option[0]"
        type="button"
        :aria-pressed="(selectedBallEvent.serve_style ?? 'JUMP') === option[0]"
        :disabled="!eventEditState.enabled"
        @click="chooseServeStyle(option[0])"
      >
        {{ option[1] }}
      </button>
    </div>

    <div class="result-switch" aria-label="球點結果">
      <button
        v-for="option in [
          ['SUCCESS', '成功', 'V'],
          ['FAILURE', '失敗', 'B'],
        ] as const"
        :key="option[0]"
        type="button"
        :class="option[0].toLowerCase()"
        :aria-pressed="resultSelected(option[0])"
        :disabled="!resultEnabled || !eventEditState.enabled"
        :title="
          !resultEnabled ? 'HIT 不使用成功或失敗；請先選擇球種' : `按 ${option[2]} 標記${option[1]}`
        "
        @click="chooseResult(option[0])"
      >
        <UiKbd>{{ option[2] }}</UiKbd
        ><span>{{ option[1] }}</span>
      </button>
    </div>

    <UiPopover
      :open="actorOpen"
      side="bottom"
      align="end"
      content-class="ball-event-actor-popover"
      aria-label="修改擊球球員"
      @update:open="actorOpen = $event"
    >
      <template #trigger>
        <UiButton
          variant="secondary"
          class="point-detail-button actor"
          :disabled="!workstation.actions.state('mark.set-actor').value.enabled"
          :title="workstation.actions.state('mark.set-actor').value.reason || selectedActorLabel"
        >
          <UserRoundCheck :size="13" />
          <span>{{ selectedActorLabel }}</span>
        </UiButton>
      </template>
      <div class="point-detail-options actor-options">
        <strong>擊球球員</strong>
        <button type="button" :aria-pressed="selectedActorId === null" @click="chooseActor(null)">
          <span>未指定／使用 Pose 關聯</span>
          <Check v-if="selectedActorId === null" :size="14" />
        </button>
        <button
          v-for="option in actorOptions"
          :key="option.id"
          type="button"
          :aria-pressed="selectedActorId === option.id"
          @click="chooseActor(option.id)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="selectedActorId === option.id" :size="14" />
        </button>
      </div>
    </UiPopover>
  </div>
</template>

<style scoped>
.selected-point-editor {
  position: relative;
  width: min(680px, calc(100vw - 160px));
  min-height: 42px;
  display: flex;
  align-items: stretch;
  gap: 6px;
  padding: 4px;
  border-radius: 10px;
  background: rgb(10 13 16 / 97%);
  box-shadow: 0 9px 28px #000a;
  pointer-events: auto;
}
.selected-point-editor > i {
  position: absolute;
  left: 50%;
  top: -6px;
  width: 11px;
  height: 11px;
  transform: translateX(-50%) rotate(45deg);
  background: #0a0d10;
}
.point-editor-position {
  display: grid;
  grid-auto-flow: row;
  grid-auto-rows: minmax(20px, 1fr);
  gap: 2px;
  flex: none;
  padding: 2px;
  border-radius: 7px;
  background: #15191d;
}
.point-editor-position button {
  min-width: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 3px 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #88929d;
  font-size: 0.62rem;
  cursor: pointer;
}
.point-editor-position button.active,
.point-editor-position button:hover {
  background: #2b3945;
  color: #e8f2fb;
}
.selected-point-editor.pinned > i {
  display: none;
}
.selected-point-editor :deep(.point-detail-button) {
  min-width: 0;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-color: #343b43;
  background: #171b20;
  color: #e8edf2;
}
.event-kind {
  flex: 0 1 150px;
}
.actor {
  flex: 1 1 190px;
}
.selected-point-editor :deep(.point-detail-button span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-swatch {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--point-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--point-accent) 65%, transparent);
}
.serve-style,
.result-switch {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(58px, 1fr);
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  background: #15191d;
}
.serve-style button,
.result-switch button {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #aeb5bd;
  font-size: 0.7rem;
  cursor: pointer;
}
.serve-style button[aria-pressed='true'] {
  background: #3b2c12;
  color: #ffd98a;
}
.result-switch .success[aria-pressed='true'] {
  background: #16483b;
  color: #b8ffe9;
}
.result-switch .failure[aria-pressed='true'] {
  background: #50202d;
  color: #ffd0dc;
}
.serve-style button:disabled,
.result-switch button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.point-detail-options {
  display: grid;
  gap: 4px;
  min-width: 180px;
}
.point-detail-options strong {
  padding: 4px 7px 7px;
  color: #f4f4f5;
  font-size: 0.72rem;
}
.point-detail-options button {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #d4d4d8;
  font-size: 0.72rem;
  cursor: pointer;
}
.point-detail-options button:hover,
.point-detail-options button[aria-pressed='true'] {
  background: #27272a;
  color: #fff;
}
.actor-options {
  width: min(320px, 75vw);
  max-height: 360px;
  overflow: auto;
}
</style>
