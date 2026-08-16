<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  Keyboard,
  RotateCcw,
  Scissors,
} from 'lucide-vue-next'
import UiButton from '~/components/ui/Button.vue'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  HOTKEY_COMMANDS,
  MEDIA_COMMANDS,
  type HotkeyCommand,
  type HotkeyCommandDefinition,
} from '~/utils/annotationHotkeys'
import { MEDIA_BUFFER_PROFILES, type MediaBufferPreset } from '~/utils/mediaPlaybackPreferences'
import { useAnnotationWorkstationService } from '~/services/annotation-workstation/annotation-workstation.service'

type SettingsPage = 'root' | 'media' | 'overlay' | 'clip' | 'hotkeys'
type PageDirection = 'forward' | 'back'

const workstation = useAnnotationWorkstationService()
if (!workstation.preferences) throw new Error('Annotation settings require workstation preferences')
const preferences = workstation.preferences
const open = preferences.settingsOpen
const initialPage = preferences.settingsPage
const clipPolicySaving = preferences.clipPolicySaving
const clipPolicyError = preferences.clipPolicyError
const overlayEnabled = preferences.overlayEnabled
const model = workstation.annotation.model
const { bindings, rebind, restoreDefaults } = useAnnotationHotkeys()
const { bufferPreset, setBufferPreset } = useMediaPlaybackPreferences()
const page = ref<SettingsPage>(initialPage.value)
const recording = ref<HotkeyCommand | null>(null)
const recordingError = ref<string | null>(null)
const clipPreRollSeconds = ref(model.clipPreRollSeconds.value)
const clipPostRollSeconds = ref(model.clipPostRollSeconds.value)
const clipValidationError = ref<string | null>(null)
const pageDirection = ref<PageDirection>('forward')
const commandGroups: ReadonlyArray<{
  label: string
  commands: ReadonlyArray<HotkeyCommandDefinition>
}> = [
  { label: '標記', commands: ANNOTATION_COMMANDS },
  { label: '播放', commands: MEDIA_COMMANDS },
]
const mediaPresets = Object.entries(MEDIA_BUFFER_PROFILES) as Array<
  [MediaBufferPreset, (typeof MEDIA_BUFFER_PROFILES)[MediaBufferPreset]]
>
const modalTitle = computed(() =>
  page.value === 'root'
    ? '設定'
    : page.value === 'media'
      ? '媒體播放設定'
      : page.value === 'overlay'
        ? '疊圖設定'
        : page.value === 'clip'
          ? '片段範圍'
          : '按鍵設定',
)
const modalDescription = computed(() =>
  page.value === 'root'
    ? '調整此瀏覽器的標註工作站偏好'
    : page.value === 'media'
      ? '控制播放時保留的影音緩衝'
      : page.value === 'overlay'
        ? '控制標記畫面中的 AI 疊圖；不影響人工球種資料'
        : page.value === 'clip'
          ? '套用到本場尚未送出的標記與後續修正版草稿'
          : '點選按鍵後直接輸入新的組合',
)
const modalHeight = computed<'medium' | 'tall'>(() =>
  page.value === 'hotkeys' ? 'tall' : 'medium',
)

const recorder = useAnnotationHotkeyRecorder(() => ({
  ignoreInputs: true,
  onCancel: () => {
    recording.value = null
  },
  onRecord: hotkey => {
    const action = recording.value
    if (!action) return
    const result = rebind(action, hotkey)
    recording.value = null
    if (result.ok) {
      recordingError.value = null
      return
    }
    if (result.reason === 'conflict') {
      const conflict = HOTKEY_COMMANDS.find(command => command.action === result.conflictWith)
      recordingError.value = `此按鍵已綁定到「${conflict?.label ?? result.conflictWith}」，原綁定保持不變。`
    } else if (result.reason === 'reserved')
      recordingError.value = '此按鍵組合由瀏覽器保留，原綁定保持不變。'
    else recordingError.value = '此按鍵無法用於快捷鍵，原綁定保持不變。'
  },
}))

watch(
  () => [open.value, initialPage.value] as const,
  ([open, initialPage], previous) => {
    if (open && (!previous?.[0] || initialPage !== previous[1])) page.value = initialPage
  },
  { immediate: true },
)
watch(
  () => [model.clipPreRollSeconds.value, model.clipPostRollSeconds.value] as const,
  ([before, after]) => {
    clipPreRollSeconds.value = before
    clipPostRollSeconds.value = after
  },
  { immediate: true },
)

function beginRecording(action: HotkeyCommand) {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = action
  recordingError.value = null
  recorder.startRecording()
}

function changePage(next: SettingsPage) {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = null
  if (next === page.value) return
  pageDirection.value = next === 'root' ? 'back' : 'forward'
  page.value = next
}

function restoreAllDefaults() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = null
  recordingError.value = null
  restoreDefaults()
}

function saveClipPolicy() {
  const before = Number(clipPreRollSeconds.value)
  const after = Number(clipPostRollSeconds.value)
  if (
    !Number.isInteger(before) ||
    !Number.isInteger(after) ||
    before < 0 ||
    after < 0 ||
    before > 30 ||
    after > 30
  ) {
    clipValidationError.value = '前後延展必須是 0–30 秒的整數。'
    return
  }
  clipValidationError.value = null
  void preferences.updateClipPolicy(before, after)
}

function close() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  preferences.close()
}
</script>

<template>
  <UiAnimatedModal
    :open="open"
    :title="modalTitle"
    :description="modalDescription"
    :height="modalHeight"
    header-layout="navigation"
    @close="close"
  >
    <template #header-leading>
      <UiButton
        v-if="page !== 'root'"
        variant="ghost"
        size="icon-sm"
        class="settings-header-back"
        aria-label="返回所有設定"
        @click="changePage('root')"
        ><ChevronLeft :size="19" stroke-width="2.2"
      /></UiButton>
    </template>
    <div class="settings-page-viewport">
      <Transition :name="`settings-${pageDirection}`">
        <div :key="page" class="settings-page" :data-page="page">
          <UiScrollArea class="settings-page__scroll">
            <div v-if="page === 'root'" class="settings-menu">
              <UiButton variant="ghost" class="settings-menu__item" @click="changePage('media')">
                <span class="settings-menu__icon"><Database :size="18" /></span>
                <span><strong>媒體播放設定</strong><small>瀏覽器緩衝與回放保留範圍</small></span>
                <ChevronRight :size="17" />
              </UiButton>
              <UiButton variant="ghost" class="settings-menu__item" @click="changePage('overlay')">
                <span class="settings-menu__icon"><Eye :size="18" /></span>
                <span
                  ><strong>疊圖設定</strong><small>球員框、球與動作模型只供畫面輔助</small></span
                >
                <ChevronRight :size="17" />
              </UiButton>
              <UiButton variant="ghost" class="settings-menu__item" @click="changePage('clip')">
                <span class="settings-menu__icon"><Scissors :size="18" /></span>
                <span><strong>片段範圍</strong><small>Z 標記範圍之外要額外保留的秒數</small></span>
                <ChevronRight :size="17" />
              </UiButton>
              <UiButton variant="ghost" class="settings-menu__item" @click="changePage('hotkeys')">
                <span class="settings-menu__icon"><Keyboard :size="18" /></span>
                <span><strong>按鍵設定</strong><small>標記與播放快捷鍵</small></span>
                <ChevronRight :size="17" />
              </UiButton>
            </div>

            <div v-else-if="page === 'media'" class="settings-child">
              <section class="buffer-settings">
                <div class="buffer-settings__heading">
                  <strong>瀏覽器快取大小</strong
                  ><small>較大的緩衝可減少長時間播放與回放切換時的等待。</small>
                </div>
                <div class="buffer-presets" role="radiogroup" aria-label="瀏覽器快取大小">
                  <UiButton
                    v-for="[value, profile] in mediaPresets"
                    :key="value"
                    variant="ghost"
                    class="buffer-preset"
                    :class="{ selected: bufferPreset === value }"
                    role="radio"
                    :aria-checked="bufferPreset === value"
                    @click="setBufferPreset(value)"
                  >
                    <span
                      ><strong>{{ profile.label }}</strong
                      ><small>{{ profile.description }}</small></span
                    >
                    <i aria-hidden="true" />
                  </UiButton>
                </div>
              </section>
            </div>

            <div v-else-if="page === 'overlay'" class="settings-child">
              <section class="buffer-settings">
                <div class="buffer-settings__heading">
                  <strong>分析疊圖</strong
                  ><small>關閉時不下載或繪製 overlay；人工球種與時間點仍可照常編輯。</small>
                </div>
                <div class="settings-toggle-row">
                  <span><strong>顯示 AI 疊圖</strong><small>只影響此瀏覽器</small></span>
                  <UiSwitch
                    :model-value="overlayEnabled"
                    aria-label="顯示 AI 疊圖"
                    @update:model-value="preferences.setOverlayEnabled"
                  />
                </div>
              </section>
            </div>

            <div v-else-if="page === 'clip'" class="settings-child">
              <section class="clip-settings">
                <div class="clip-setting-row">
                  <label for="clip-pre-roll"
                    ><strong>開始前延伸</strong><small>第一次按 Z 的片段開始之前</small></label
                  >
                  <span
                    ><input
                      id="clip-pre-roll"
                      v-model.number="clipPreRollSeconds"
                      type="number"
                      min="0"
                      max="30"
                      step="1"
                    /><i>秒</i></span
                  >
                </div>
                <div class="clip-setting-row">
                  <label for="clip-post-roll"
                    ><strong>結束後延伸</strong><small>第二次按 Z 的片段結束之後</small></label
                  >
                  <span
                    ><input
                      id="clip-post-roll"
                      v-model.number="clipPostRollSeconds"
                      type="number"
                      min="0"
                      max="30"
                      step="1"
                    /><i>秒</i></span
                  >
                </div>
                <p>
                  預設為 0 秒，不改動你用 Z
                  標記的片段範圍。設定只套用到之後送出的新片段或修正版；已完成片段維持原範圍。
                </p>
                <p
                  v-if="clipValidationError || clipPolicyError"
                  class="annotation-settings__error"
                  role="alert"
                >
                  {{ clipValidationError || clipPolicyError }}
                </p>
                <UiButton :disabled="clipPolicySaving" @click="saveClipPolicy">{{
                  clipPolicySaving ? '儲存中…' : '套用到本場'
                }}</UiButton>
              </section>
            </div>

            <div v-else class="settings-child settings-child--hotkeys">
              <div class="annotation-settings__body">
                <section v-for="group in commandGroups" :key="group.label">
                  <h3>{{ group.label }}</h3>
                  <ul>
                    <li v-for="command in group.commands" :key="command.action">
                      <div>
                        <strong>{{ command.label }}</strong
                        ><small>{{ command.description }}</small>
                      </div>
                      <UiButton
                        variant="secondary"
                        size="sm"
                        :class="{ recording: recording === command.action }"
                        @click="beginRecording(command.action)"
                      >
                        <span v-if="recording === command.action">請按新按鍵…</span
                        ><UiKbd v-else>{{
                          formatBindingForDisplay(bindings[command.action])
                        }}</UiKbd>
                      </UiButton>
                    </li>
                  </ul>
                </section>
                <p v-if="recordingError" class="annotation-settings__error" role="alert">
                  {{ recordingError }}
                </p>
              </div>
            </div>
          </UiScrollArea>
        </div>
      </Transition>
    </div>
    <template #footer>
      <UiButton v-if="page === 'hotkeys'" variant="ghost" @click="restoreAllDefaults"
        ><RotateCcw :size="15" />還原預設值</UiButton
      >
      <UiButton @click="close">完成</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.settings-page-viewport {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #09090b;
  isolation: isolate;
}
.settings-page {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #09090b;
}
.settings-page__scroll {
  height: 100%;
  min-height: 0;
}
.settings-header-back {
  color: #a1a1aa;
}
.settings-header-back:hover {
  background: #27272a;
  color: #fafafa;
}
.settings-menu {
  display: grid;
  gap: 6px;
  padding: 12px 18px 18px 12px;
}
.settings-menu__item {
  width: 100%;
  min-height: 64px;
  justify-content: flex-start;
  padding: 10px 12px;
  text-align: left;
}
.settings-menu__item > span:nth-child(2) {
  display: grid;
  flex: 1;
  gap: 3px;
}
.settings-menu__item strong,
.buffer-preset strong {
  font-size: 0.74rem;
}
.settings-menu__item small,
.buffer-preset small,
.buffer-settings__heading small {
  color: #a1a1aa;
  font-size: 0.63rem;
  font-weight: 500;
}
.settings-menu__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 8px;
  background: #18181b;
  color: #d4d4d8;
}
.settings-child {
  min-height: 0;
  padding: 12px 18px 18px 12px;
}
.settings-child--hotkeys {
  display: block;
}
.buffer-settings {
  display: grid;
  gap: 10px;
  padding: 4px;
}
.buffer-settings__heading {
  display: grid;
  gap: 4px;
  padding: 4px 2px;
}
.settings-toggle-row {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #18181b;
}
.settings-toggle-row > span {
  display: grid;
  gap: 3px;
}
.settings-toggle-row small {
  color: #a1a1aa;
  font-size: 0.62rem;
}
.buffer-presets {
  display: grid;
  gap: 4px;
}
.buffer-preset {
  width: 100%;
  min-height: 54px;
  justify-content: space-between;
  padding: 8px 10px;
  text-align: left;
}
.buffer-preset > span {
  display: grid;
  gap: 3px;
}
.buffer-preset i {
  width: 14px;
  height: 14px;
  border: 1px solid #52525b;
  border-radius: 999px;
}
.buffer-preset.selected {
  background: #27272a;
  color: #fafafa;
}
.buffer-preset.selected i {
  border: 4px solid #fafafa;
}
.annotation-settings__body {
  padding: 4px 6px 18px;
}
.annotation-settings__body section + section {
  margin-top: 18px;
}
.annotation-settings__body h3 {
  margin: 0 0 6px;
  color: #d4d4d8;
  font-size: 0.67rem;
}
.annotation-settings__body ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.annotation-settings__body li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 9px 0;
  border-bottom: 1px solid #27272a;
}
.annotation-settings__body li div {
  display: grid;
  gap: 2px;
}
.annotation-settings__body li strong {
  font-size: 0.72rem;
}
.annotation-settings__body li small {
  color: #a1a1aa;
  font-size: 0.62rem;
}
.annotation-settings__body li :deep(button) {
  min-width: 118px;
  font:
    700 0.66rem 'Cascadia Mono',
    Consolas,
    monospace;
}
.annotation-settings__body li :deep(button.recording) {
  box-shadow: 0 0 0 2px #fafafa;
  background: #3f3f46;
}
.annotation-settings__error {
  padding: 8px;
  border-radius: 7px;
  background: #2b1114;
  color: #fca5a5;
  font-size: 0.68rem;
}
.settings-forward-enter-active,
.settings-forward-leave-active,
.settings-back-enter-active,
.settings-back-leave-active {
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform;
}
.settings-forward-leave-active,
.settings-back-leave-active {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.settings-forward-enter-active,
.settings-back-enter-active {
  position: relative;
  z-index: 2;
}
.settings-forward-enter-from {
  transform: translateX(44px);
}
.settings-forward-leave-to {
  transform: translateX(-28px);
}
.settings-back-enter-from {
  transform: translateX(-44px);
}
.settings-back-leave-to {
  transform: translateX(28px);
}
</style>

<style scoped>
.clip-settings {
  display: grid;
  gap: 8px;
  padding: 4px;
}
.clip-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 2px;
  border-bottom: 1px solid #27272a;
}
.clip-setting-row label {
  display: grid;
  gap: 3px;
}
.clip-setting-row strong {
  font-size: 0.74rem;
}
.clip-setting-row small,
.clip-settings > p {
  color: #a1a1aa;
  font-size: 0.63rem;
}
.clip-setting-row > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.clip-setting-row input {
  width: 72px;
  height: 34px;
  border: 1px solid #3f3f46;
  border-radius: 7px;
  background: #111113;
  color: #fafafa;
  font:
    700 0.74rem 'Cascadia Mono',
    Consolas,
    monospace;
  text-align: center;
}
.clip-setting-row i {
  color: #a1a1aa;
  font-size: 0.66rem;
  font-style: normal;
}
.clip-settings > p {
  margin: 4px 0 2px;
  line-height: 1.55;
}
</style>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .settings-forward-enter-active,
  .settings-forward-leave-active,
  .settings-back-enter-active,
  .settings-back-leave-active {
    transition-duration: 120ms;
    transition-property: opacity;
  }
  .settings-forward-enter-from,
  .settings-forward-leave-to,
  .settings-back-enter-from,
  .settings-back-leave-to {
    opacity: 0;
    transform: none;
  }
}
</style>
