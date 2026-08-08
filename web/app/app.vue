<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'

const route = useRoute()
const layoutName = computed(() => {
  if (route.path.startsWith('/annotate/')) return 'annotation'
  if (route.path === '/control' || route.path.startsWith('/control/')) return 'control'
  return 'coach'
})
</script>

<template>
  <NuxtLayout :name="layoutName"><NuxtPage /></NuxtLayout>
  <Toaster position="top-right" theme="dark" rich-colors close-button />
</template>
