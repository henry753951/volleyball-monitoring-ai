<script setup lang="ts">
import type { CreateMatchSetupInput } from '../../lib/coreDomain'

const setup = useCreateMatchSetup()
const router = useRouter()
async function submit(input: CreateMatchSetupInput) {
  try {
    const match = await setup.create(input)
    await router.push(`/matches/${match.id}/live`)
  }
  catch {
    // The composable retains the stable API error for the form; inputs remain mounted.
  }
}
</script>

<template>
  <section class="space-y-6">
    <header><p class="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">新場次</p><h1 class="mt-2 text-3xl font-semibold tracking-tight">建立比賽資料</h1><p class="mt-2 max-w-3xl text-stone-600">一次提交場次、兩側隊伍與 roster；伺服器會以單一 transaction 建立完整關聯。</p></header>
    <MatchSetupForm :pending="setup.pending.value" :error="setup.error.value" @submit="submit" @cancel="router.back()" />
  </section>
</template>
