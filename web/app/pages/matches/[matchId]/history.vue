<script setup lang="ts">
definePageMeta({
  middleware: to =>
    navigateTo(`/matches/${String(to.params.matchId)}/rallies`, {
      redirectCode: 301,
    }),
})
</script>

<template><span /></template>
