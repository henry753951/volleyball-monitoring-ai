<script setup lang="ts">
import { useEventListener, useScrollLock } from '@vueuse/core'
import { AnimatePresence, Motion } from 'motion-v'
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  width?: 'compact' | 'default' | 'wide'
  closeLabel?: string
}>(), { width: 'default', closeLabel: '關閉' })
const emit = defineEmits<{ close: [] }>()
const body = useTemplateRef<HTMLElement>('body')
const lock = useScrollLock(import.meta.client ? document.body : null)
let previousFocus: HTMLElement | null = null

watch(() => props.open, async (open) => {
  if (!import.meta.client) return
  lock.value = open
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    body.value?.focus({ preventScroll: true })
  }
  else previousFocus?.focus({ preventScroll: true })
}, { immediate: true })
useEventListener('keydown', (event: KeyboardEvent) => {
  if (props.open && event.key === 'Escape') emit('close')
})
onBeforeUnmount(() => { lock.value = false })
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <Motion v-if="open" class="animated-modal__backdrop" :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }" :transition="{ duration: .16 }" @pointerdown.self="emit('close')">
        <Motion ref="body" tabindex="-1" class="animated-modal" :class="`animated-modal--${width}`" role="dialog" aria-modal="true" :aria-label="title" :initial="{ opacity: 0, scale: .82, rotateX: 14, y: 28 }" :animate="{ opacity: 1, scale: 1, rotateX: 0, y: 0 }" :exit="{ opacity: 0, scale: .92, y: 12 }" :transition="{ type: 'spring', stiffness: 360, damping: 30, mass: .78 }">
          <header class="animated-modal__header">
            <div><strong>{{ title }}</strong><span v-if="description">{{ description }}</span></div>
            <button type="button" :aria-label="closeLabel" @click="emit('close')"><X :size="17" /></button>
          </header>
          <div class="animated-modal__content"><slot /></div>
          <footer v-if="$slots.footer" class="animated-modal__footer"><slot name="footer" /></footer>
        </Motion>
      </Motion>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.animated-modal__backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;background:#030507b8;backdrop-filter:blur(12px) saturate(120%);perspective:1200px}.animated-modal{width:min(720px,calc(100vw - 32px));max-height:min(86dvh,860px);display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;border:1px solid #3d4650;border-radius:18px;outline:0;background:#11151a;color:#f3f5f7;box-shadow:0 34px 100px #000c,0 1px 0 #ffffff12 inset;transform-origin:50% 18%}.animated-modal--compact{width:min(520px,calc(100vw - 32px))}.animated-modal--wide{width:min(1040px,calc(100vw - 32px))}.animated-modal__header{min-height:52px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:10px 12px 10px 17px;border-bottom:1px solid #2d343c;background:#151a20}.animated-modal__header>div{display:grid;gap:2px}.animated-modal__header strong{font-size:.8rem;letter-spacing:.01em}.animated-modal__header span{color:#8f9aa5;font-size:.63rem}.animated-modal__header button{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:#aab3bd;cursor:pointer}.animated-modal__header button:hover{border-color:#3e4852;background:#232a32;color:#fff}.animated-modal__content{min-height:0;overflow:hidden}.animated-modal__footer{min-height:52px;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:9px 14px;border-top:1px solid #2d343c;background:#151a20}@media(prefers-reduced-motion:reduce){.animated-modal__backdrop{backdrop-filter:none}}
</style>
