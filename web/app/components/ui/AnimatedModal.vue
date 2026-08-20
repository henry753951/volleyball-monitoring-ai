<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { X } from 'lucide-vue-next'
import UiButton from './Button.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    width?: 'compact' | 'default' | 'wide' | 'full'
    height?: 'auto' | 'medium' | 'tall'
    closeLabel?: string
    headerLayout?: 'default' | 'navigation'
  }>(),
  { width: 'default', height: 'auto', closeLabel: '關閉', headerLayout: 'default' },
)
const emit = defineEmits<{ close: [] }>()

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="animated-modal__backdrop" />
      <DialogContent
        class="animated-modal"
        :class="[`animated-modal--${width}`, `animated-modal--height-${height}`]"
      >
        <header class="animated-modal__header" :class="`animated-modal__header--${headerLayout}`">
          <div class="animated-modal__header-main">
            <div v-if="$slots['header-leading']" class="animated-modal__header-leading">
              <slot name="header-leading" />
            </div>
            <div class="animated-modal__header-copy">
              <DialogTitle class="animated-modal__title">{{ title }}</DialogTitle>
              <DialogDescription v-if="description" class="animated-modal__description">{{
                description
              }}</DialogDescription>
            </div>
          </div>
          <DialogClose as-child>
            <UiButton variant="ghost" size="icon-sm" :aria-label="closeLabel"
              ><X :size="17"
            /></UiButton>
          </DialogClose>
        </header>
        <div class="animated-modal__content"><slot /></div>
        <footer v-if="$slots.footer" class="animated-modal__footer"><slot name="footer" /></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.animated-modal__backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgb(0 0 0 / 72%);
}
.animated-modal__backdrop[data-state='open'] {
  animation: modal-overlay-in 160ms ease-out both;
}
.animated-modal__backdrop[data-state='closed'] {
  animation: modal-overlay-out 130ms ease-in both;
}
.animated-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 1001;
  width: min(720px, calc(100vw - 32px));
  max-height: min(86dvh, 860px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid #27272a;
  border-radius: 12px;
  outline: 0;
  background: #09090b;
  color: #fafafa;
  box-shadow: 0 24px 80px rgb(0 0 0 / 70%);
  transform: translate(-50%, -50%);
}
.animated-modal[data-state='open'] {
  animation: modal-content-in 190ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.animated-modal[data-state='closed'] {
  animation: modal-content-out 140ms cubic-bezier(0.4, 0, 1, 1) both;
}
.animated-modal--compact {
  width: min(520px, calc(100vw - 32px));
}
.animated-modal--wide {
  width: min(1040px, calc(100vw - 32px));
}
.animated-modal--full {
  width: min(1480px, calc(100vw - 40px));
  max-height: min(92dvh, 940px);
}
.animated-modal--height-medium {
  height: min(68dvh, 620px);
}
.animated-modal--height-tall {
  height: min(86dvh, 860px);
}
.animated-modal__header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 12px 10px 18px;
  border-bottom: 1px solid #27272a;
  background: #09090b;
}
.animated-modal__header-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.animated-modal__header-leading {
  flex: none;
}
.animated-modal__header-leading:empty {
  display: none;
}
.animated-modal__header-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.animated-modal__header--navigation {
  grid-template-columns: 34px minmax(0, 1fr) 34px;
  gap: 10px;
}
.animated-modal__header--navigation .animated-modal__header-main {
  display: contents;
}
.animated-modal__header--navigation .animated-modal__header-leading {
  grid-column: 1;
  display: grid;
  place-items: center;
}
.animated-modal__header--navigation .animated-modal__header-copy {
  grid-column: 2;
  text-align: center;
}
.animated-modal__header--navigation > :last-child {
  grid-column: 3;
}
.animated-modal__title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.animated-modal__description {
  margin: 0;
  color: #a1a1aa;
  font-size: 0.63rem;
}
.animated-modal__content {
  min-height: 0;
  overflow: hidden;
  background: #09090b;
}
.animated-modal__footer {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #27272a;
  background: #09090b;
}
@keyframes modal-overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes modal-overlay-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes modal-content-in {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 10px)) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}
@keyframes modal-content-out {
  from {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  to {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 8px)) scale(0.98);
  }
}
@media (prefers-reduced-motion: reduce) {
  .animated-modal__backdrop[data-state],
  .animated-modal[data-state] {
    animation-duration: 1ms;
  }
}
</style>
