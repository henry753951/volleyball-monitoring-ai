<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'

const route = useRoute()
const layoutName = computed(() => {
  if (route.path === '/login') return 'auth'
  if (route.path.startsWith('/annotate/')) return 'annotation'
  if (route.path === '/control' || route.path.startsWith('/control/')) return 'control'
  return 'coach'
})
const pageTransition = computed(() =>
  layoutName.value === 'coach' ? { name: 'coach-page', mode: 'out-in' as const } : false,
)
</script>

<template>
  <NuxtLayout :name="layoutName"><NuxtPage :transition="pageTransition" /></NuxtLayout>
  <Toaster position="top-right" theme="dark" rich-colors close-button />
</template>

<style>
.coach-page-enter-active {
  transition:
    opacity 260ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 260ms cubic-bezier(0.16, 1, 0.3, 1),
    filter 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.coach-page-leave-active {
  transition:
    opacity 140ms ease-in,
    transform 140ms ease-in;
}
.coach-page-enter-from {
  opacity: 0;
  transform: translateY(8px);
  filter: blur(3px);
}
.coach-page-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .coach-page-enter-active,
  .coach-page-leave-active {
    transition: opacity 120ms linear;
  }
  .coach-page-enter-from,
  .coach-page-leave-to {
    transform: none;
    filter: none;
  }
}
</style>
