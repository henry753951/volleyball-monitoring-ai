<script setup lang="ts">
import { ArrowLeft, ChevronRight, Database, Keyboard, RotateCcw } from 'lucide-vue-next'
import UiButton from '~/components/ui/Button.vue'
import {
  ANNOTATION_COMMANDS,
  formatBindingForDisplay,
  HOTKEY_COMMANDS,
  MEDIA_COMMANDS,
  type HotkeyCommand,
  type HotkeyCommandDefinition,
} from '~/utils/annotationHotkeys'
import {
  MEDIA_BUFFER_PROFILES,
  type MediaBufferPreset,
} from '~/utils/mediaPlaybackPreferences'

type SettingsPage = 'root' | 'media' | 'hotkeys'
type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

const props = withDefaults(defineProps<{
  open: boolean
  initialPage?: SettingsPage
}>(), { initialPage: 'root' })
const emit = defineEmits<{ close: [] }>()
const { bindings, rebind, restoreDefaults } = useAnnotationHotkeys()
const { bufferPreset, setBufferPreset } = useMediaPlaybackPreferences()
const page = ref<SettingsPage>(props.initialPage)
const recording = ref<HotkeyCommand | null>(null)
const recordingError = ref<string | null>(null)
const commandGroups: ReadonlyArray<{ label: string; commands: ReadonlyArray<HotkeyCommandDefinition> }> = [
  { label: '標記', commands: ANNOTATION_COMMANDS },
  { label: '播放', commands: MEDIA_COMMANDS },
]
const mediaPresets = Object.entries(MEDIA_BUFFER_PROFILES) as Array<[MediaBufferPreset, typeof MEDIA_BUFFER_PROFILES[MediaBufferPreset]]>
const modalTitle = computed(() => page.value === 'root' ? '設定' : page.value === 'media' ? '媒體播放設定' : '按鍵設定')
const modalDescription = computed(() => page.value === 'root'
  ? '調整此瀏覽器的標註工作站偏好'
  : page.value === 'media'
    ? '控制播放時保留的影音緩衝'
    : '點選按鍵後直接輸入新的組合')
const modalHeight = computed<'auto' | 'tall'>(() => page.value === 'hotkeys' ? 'tall' : 'auto')

const recorder = useAnnotationHotkeyRecorder(() => ({
  ignoreInputs: true,
  onCancel: () => { recording.value = null },
  onRecord: (hotkey) => {
    const action = recording.value
    if (!action) return
    const result = rebind(action, hotkey)
    recording.value = null
    if (result.ok) { recordingError.value = null; return }
    if (result.reason === 'conflict') {
      const conflict = HOTKEY_COMMANDS.find(command => command.action === result.conflictWith)
      recordingError.value = `此按鍵已綁定到「${conflict?.label ?? result.conflictWith}」，原綁定保持不變。`
    }
    else if (result.reason === 'reserved') recordingError.value = '此按鍵組合由瀏覽器保留，原綁定保持不變。'
    else recordingError.value = '此按鍵無法用於快捷鍵，原綁定保持不變。'
  },
}))

watch(() => [props.open, props.initialPage] as const, ([open, initialPage], previous) => {
  if (open && (!previous?.[0] || initialPage !== previous[1])) page.value = initialPage
}, { immediate: true })

function beginRecording(action: HotkeyCommand) {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = action
  recordingError.value = null
  recorder.startRecording()
}

function changePage(next: SettingsPage) {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = null
  const update = () => { page.value = next }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const transitionDocument = document as TransitionDocument
  if (!reducedMotion && transitionDocument.startViewTransition) transitionDocument.startViewTransition(update)
  else update()
}

function restoreAllDefaults() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  recording.value = null
  recordingError.value = null
  restoreDefaults()
}

function close() {
  if (recorder.isRecording.value) recorder.cancelRecording()
  emit('close')
}
</script>

<template>
  <UiAnimatedModal :open="open" :title="modalTitle" :description="modalDescription" :height="modalHeight" @close="close">
    <div class="settings-page" :data-page="page">
      <div v-if="page === 'root'" class="settings-menu">
        <UiButton variant="ghost" class="settings-menu__item" @click="changePage('media')">
          <span class="settings-menu__icon"><Database :size="18" /></span>
          <span><strong>媒體播放設定</strong><small>瀏覽器緩衝與回放保留範圍</small></span>
          <ChevronRight :size="17" />
        </UiButton>
        <UiButton variant="ghost" class="settings-menu__item" @click="changePage('hotkeys')">
          <span class="settings-menu__icon"><Keyboard :size="18" /></span>
          <span><strong>按鍵設定</strong><small>標記與播放快捷鍵</small></span>
          <ChevronRight :size="17" />
        </UiButton>
      </div>

      <div v-else-if="page === 'media'" class="settings-child">
        <UiButton variant="ghost" size="sm" class="settings-back" @click="changePage('root')"><ArrowLeft :size="15" />所有設定</UiButton>
        <section class="buffer-settings">
          <div class="buffer-settings__heading"><strong>瀏覽器快取大小</strong><small>較大的緩衝可減少長時間播放與回放切換時的等待。</small></div>
          <div class="buffer-presets" role="radiogroup" aria-label="瀏覽器快取大小">
            <UiButton
              v-for="([value, profile]) in mediaPresets"
              :key="value"
              variant="ghost"
              class="buffer-preset"
              :class="{ selected: bufferPreset === value }"
              role="radio"
              :aria-checked="bufferPreset === value"
              @click="setBufferPreset(value)"
            >
              <span><strong>{{ profile.label }}</strong><small>{{ profile.description }}</small></span>
              <i aria-hidden="true" />
            </UiButton>
          </div>
        </section>
      </div>

      <div v-else class="settings-child settings-child--hotkeys">
        <UiButton variant="ghost" size="sm" class="settings-back" @click="changePage('root')"><ArrowLeft :size="15" />所有設定</UiButton>
        <UiScrollArea class="annotation-settings__scroll">
          <div class="annotation-settings__body">
            <section v-for="group in commandGroups" :key="group.label">
              <h3>{{ group.label }}</h3>
              <ul>
                <li v-for="command in group.commands" :key="command.action">
                  <div><strong>{{ command.label }}</strong><small>{{ command.description }}</small></div>
                  <UiButton variant="secondary" size="sm" :class="{ recording: recording === command.action }" @click="beginRecording(command.action)">
                    <span v-if="recording === command.action">請按新按鍵…</span><UiKbd v-else>{{ formatBindingForDisplay(bindings[command.action]) }}</UiKbd>
                  </UiButton>
                </li>
              </ul>
            </section>
            <p v-if="recordingError" class="annotation-settings__error" role="alert">{{ recordingError }}</p>
          </div>
        </UiScrollArea>
      </div>
    </div>
    <template #footer>
      <UiButton v-if="page === 'hotkeys'" variant="ghost" @click="restoreAllDefaults"><RotateCcw :size="15" />還原預設值</UiButton>
      <UiButton @click="close">完成</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.settings-page{min-height:0;overflow:hidden;background:#09090b;view-transition-name:annotation-settings-page}.settings-menu{display:grid;gap:6px;padding:12px}.settings-menu__item{width:100%;min-height:64px;justify-content:flex-start;padding:10px 12px;text-align:left}.settings-menu__item>span:nth-child(2){display:grid;flex:1;gap:3px}.settings-menu__item strong,.buffer-preset strong{font-size:.74rem}.settings-menu__item small,.buffer-preset small,.buffer-settings__heading small{color:#a1a1aa;font-size:.63rem;font-weight:500}.settings-menu__icon{display:grid;width:34px;height:34px;place-items:center;border-radius:8px;background:#18181b;color:#d4d4d8}.settings-child{min-height:0;padding:10px 12px 14px}.settings-child--hotkeys{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr);padding-bottom:0}.settings-back{margin-bottom:6px;padding-inline:8px}.buffer-settings{display:grid;gap:10px;padding:4px}.buffer-settings__heading{display:grid;gap:4px;padding:4px 2px}.buffer-presets{display:grid;gap:4px}.buffer-preset{width:100%;min-height:54px;justify-content:space-between;padding:8px 10px;text-align:left}.buffer-preset>span{display:grid;gap:3px}.buffer-preset i{width:14px;height:14px;border:1px solid #52525b;border-radius:999px}.buffer-preset.selected{background:#27272a;color:#fafafa}.buffer-preset.selected i{border:4px solid #fafafa}.annotation-settings__scroll{min-height:0;height:100%}.annotation-settings__body{padding:4px 6px 18px}.annotation-settings__body section+section{margin-top:18px}.annotation-settings__body h3{margin:0 0 6px;color:#d4d4d8;font-size:.67rem}.annotation-settings__body ul{margin:0;padding:0;list-style:none}.annotation-settings__body li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid #27272a}.annotation-settings__body li div{display:grid;gap:2px}.annotation-settings__body li strong{font-size:.72rem}.annotation-settings__body li small{color:#a1a1aa;font-size:.62rem}.annotation-settings__body li :deep(button){min-width:118px;font:700 .66rem "Cascadia Mono",Consolas,monospace}.annotation-settings__body li :deep(button.recording){box-shadow:0 0 0 2px #fafafa;background:#3f3f46}.annotation-settings__error{padding:8px;border-radius:7px;background:#2b1114;color:#fca5a5;font-size:.68rem}
</style>

<style>
::view-transition-old(annotation-settings-page){animation:settings-page-out 120ms cubic-bezier(.4,0,1,1) both}
::view-transition-new(annotation-settings-page){animation:settings-page-in 180ms cubic-bezier(.16,1,.3,1) both}
@keyframes settings-page-out{to{opacity:0;transform:translateX(-8px)}}
@keyframes settings-page-in{from{opacity:0;transform:translateX(10px)}}
</style>
