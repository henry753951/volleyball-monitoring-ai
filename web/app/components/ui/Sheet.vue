<script setup lang="ts">
import { X } from 'lucide-vue-next'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from 'reka-ui'

withDefaults(defineProps<{
  open?: boolean
  title: string
  description?: string
  side?: 'left' | 'right'
}>(), {
  open: false,
  description: '',
  side: 'right',
})

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogTrigger v-if="$slots.trigger" as-child><slot name="trigger" /></DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="ui-sheet__overlay" />
      <DialogContent class="ui-sheet" :class="`ui-sheet--${side}`">
        <header class="ui-sheet__header">
          <div>
            <DialogTitle class="ui-sheet__title">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" class="ui-sheet__description">{{ description }}</DialogDescription>
          </div>
          <DialogClose class="ui-sheet__close" aria-label="關閉面板"><X :size="19" /></DialogClose>
        </header>
        <UiScrollArea class="ui-sheet__scroll"><div class="ui-sheet__body"><slot /></div></UiScrollArea>
        <footer v-if="$slots.footer" class="ui-sheet__footer"><slot name="footer" /></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.ui-sheet__overlay{position:fixed;z-index:1000;inset:0;background:#07111f42;backdrop-filter:blur(3px);animation:ui-sheet-fade-in 220ms cubic-bezier(.22,1,.36,1)}
.ui-sheet{position:fixed;z-index:1001;top:0;bottom:0;width:min(390px,88vw);display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;background:rgba(249,250,252,.96);color:#16181d;box-shadow:0 0 52px #11182733;backdrop-filter:blur(28px) saturate(170%);outline:0}
.ui-sheet--right{right:0;border-left:1px solid #fff9;animation:ui-sheet-in-right 320ms cubic-bezier(.22,1,.36,1)}
.ui-sheet--left{left:0;border-right:1px solid #fff9;animation:ui-sheet-in-left 320ms cubic-bezier(.22,1,.36,1)}
.ui-sheet__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:calc(18px + env(safe-area-inset-top)) 18px 15px;border-bottom:1px solid #dfe4e9}
.ui-sheet__header>div{min-width:0;display:grid;gap:4px}.ui-sheet__title{font-size:1.05rem;font-weight:760;letter-spacing:-.02em}.ui-sheet__description{margin:0;color:#6e7681;font-size:.72rem;line-height:1.45}
.ui-sheet__close{width:40px;height:40px;display:grid;flex:none;place-items:center;border:0;border-radius:11px;background:#e8edf2;color:#4f5863}.ui-sheet__close:active{transform:scale(.96)}.ui-sheet__close:focus-visible{box-shadow:0 0 0 3px #1266c43d}
.ui-sheet__scroll{height:100%;min-height:0}.ui-sheet__body{display:grid;gap:18px;padding:18px 18px calc(28px + env(safe-area-inset-bottom))}.ui-sheet__footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #dfe4e9;background:#f9fafce8}
@keyframes ui-sheet-fade-in{from{opacity:0}}
@keyframes ui-sheet-in-right{from{transform:translate3d(100%,0,0)}}
@keyframes ui-sheet-in-left{from{transform:translate3d(-100%,0,0)}}
@media(prefers-reduced-motion:reduce){.ui-sheet__overlay,.ui-sheet{animation:ui-sheet-fade-in 160ms ease-out}}
@media(prefers-reduced-transparency:reduce){.ui-sheet{background:#f9fafc;backdrop-filter:none}.ui-sheet__overlay{backdrop-filter:none}}
</style>
