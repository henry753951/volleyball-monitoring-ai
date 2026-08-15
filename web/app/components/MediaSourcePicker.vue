<script setup lang="ts">
import { Check, FileVideo2, Link2, Upload, Youtube } from 'lucide-vue-next'
import type { MatchMediaSourceDraft } from '~/lib/mediaSourceClient'

const model = defineModel<MatchMediaSourceDraft>({ required: true })
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const youtubeUrl = computed({
  get: () => (model.value.kind === 'youtube' ? model.value.url : ''),
  set: value => {
    model.value = {
      kind: 'youtube',
      label: model.value.kind === 'youtube' ? model.value.label : '',
      url: value,
    }
  },
})
const label = computed({
  get: () => (model.value.kind === 'later' ? '' : model.value.label),
  set: value => {
    if (model.value.kind === 'youtube') model.value = { ...model.value, label: value }
    if (model.value.kind === 'local_mp4') model.value = { ...model.value, label: value }
  },
})
function select(kind: MatchMediaSourceDraft['kind']) {
  if (kind === 'youtube') model.value = { kind, label: '', url: '' }
  else if (kind === 'local_mp4') model.value = { kind, label: '', file: new File([], '') }
  else model.value = { kind }
}
function choose(file: File | undefined) {
  if (!file) return
  if (file.type !== 'video/mp4' && !file.name.toLowerCase().endsWith('.mp4')) return
  model.value = {
    kind: 'local_mp4',
    label: model.value.kind === 'local_mp4' ? model.value.label : '',
    file,
  }
}
function drop(event: DragEvent) {
  dragging.value = false
  choose(event.dataTransfer?.files[0])
}
function formatSize(bytes: number) {
  if (!bytes) return ''
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.ceil(bytes / 1024 ** 2)} MB`
}
</script>

<template>
  <section class="source-picker">
    <div class="source-tabs" role="radiogroup" aria-label="影音來源">
      <button
        type="button"
        :class="{ active: model.kind === 'youtube' }"
        @click="select('youtube')"
      >
        <Youtube :size="18" /><span><strong>YouTube</strong><small>影片或直播網址</small></span
        ><Check v-if="model.kind === 'youtube'" :size="15" />
      </button>
      <button
        type="button"
        :class="{ active: model.kind === 'local_mp4' }"
        @click="select('local_mp4')"
      >
        <FileVideo2 :size="18" /><span><strong>MP4 檔案</strong><small>從電腦上傳</small></span
        ><Check v-if="model.kind === 'local_mp4'" :size="15" />
      </button>
      <button type="button" :class="{ active: model.kind === 'later' }" @click="select('later')">
        <Link2 :size="18" /><span><strong>稍後設定</strong><small>先建立場次</small></span
        ><Check v-if="model.kind === 'later'" :size="15" />
      </button>
    </div>

    <div v-if="model.kind === 'youtube'" class="source-fields">
      <label
        ><span>YouTube 網址</span
        ><input
          v-model="youtubeUrl"
          type="url"
          required
          placeholder="https://www.youtube.com/watch?v=…"
          autocomplete="off"
      /></label>
      <label
        ><span>來源名稱（選填）</span
        ><input v-model="label" maxlength="120" placeholder="主場轉播" autocomplete="off"
      /></label>
    </div>

    <div v-else-if="model.kind === 'local_mp4'" class="source-fields">
      <button
        type="button"
        class="dropzone"
        :class="{ dragging }"
        @click="fileInput?.click()"
        @dragenter.prevent="dragging = true"
        @dragover.prevent
        @dragleave.prevent="dragging = false"
        @drop.prevent="drop"
      >
        <Upload :size="22" />
        <span v-if="model.file.name"
          ><strong>{{ model.file.name }}</strong
          ><small>{{ formatSize(model.file.size) }}</small></span
        >
        <span v-else
          ><strong>選擇或拖入 MP4</strong><small>原始檔案會由伺服器建立 DVR 索引</small></span
        >
      </button>
      <input
        ref="fileInput"
        class="sr-only"
        type="file"
        accept="video/mp4,.mp4"
        @change="choose(($event.target as HTMLInputElement).files?.[0])"
      />
      <label
        ><span>來源名稱（選填）</span
        ><input v-model="label" maxlength="120" placeholder="完整賽事影片" autocomplete="off"
      /></label>
    </div>
  </section>
</template>

<style scoped>
.source-picker {
  display: grid;
  gap: 16px;
}
.source-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
.source-tabs button {
  min-height: 76px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid #2b3035;
  border-radius: 12px;
  background: #111418;
  color: #8f969d;
  text-align: left;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    color 0.16s ease;
}
.source-tabs button:hover {
  border-color: #4b5158;
  color: #dfe2e5;
}
.source-tabs button.active {
  border-color: #8b9299;
  background: #1a1e23;
  color: #f3f4f5;
}
.source-tabs span {
  display: grid;
  gap: 4px;
}
.source-tabs strong {
  font-size: 0.72rem;
}
.source-tabs small {
  color: #777f87;
  font-size: 0.58rem;
}
.source-fields {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 12px;
  padding: 15px;
  border-radius: 12px;
  background: #111418;
}
.source-fields label {
  display: grid;
  gap: 6px;
  color: #a4aab0;
  font-size: 0.64rem;
  font-weight: 650;
}
.source-fields input {
  min-height: 39px;
  width: 100%;
  padding: 0 11px;
  border: 1px solid #30353a;
  border-radius: 9px;
  outline: 0;
  background: #181c20;
  color: #f5f5f5;
}
.source-fields input:focus {
  border-color: #aeb4ba;
  box-shadow: 0 0 0 3px #fff1;
}
.dropzone {
  grid-column: 1/-1;
  min-height: 112px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 13px;
  border: 1px dashed #3c4248;
  border-radius: 11px;
  background: #15191d;
  color: #aeb4ba;
}
.dropzone:hover,
.dropzone.dragging {
  border-color: #a3aab1;
  background: #1b2025;
  color: #fff;
}
.dropzone span {
  display: grid;
  gap: 5px;
  text-align: left;
}
.dropzone strong {
  max-width: 56ch;
  overflow: hidden;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dropzone small {
  color: #798188;
  font-size: 0.59rem;
}
@media (max-width: 720px) {
  .source-tabs,
  .source-fields {
    grid-template-columns: 1fr;
  }
  .source-tabs button {
    min-height: 62px;
  }
  .dropzone {
    grid-column: auto;
  }
}
</style>
