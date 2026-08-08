<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'
</script>

<template>
  <NuxtLayout><NuxtPage /></NuxtLayout>
  <Toaster position="top-right" theme="dark" rich-colors close-button />
</template>
