<script setup lang="ts">
import type { CreateMatchWithMediaInput } from "../../lib/mediaSourceClient";
import { createMediaSourceClient } from "../../lib/mediaSourceClient";

const setup = useCreateMatchSetup();
const router = useRouter();
const mediaSources = createMediaSourceClient();
const error = shallowRef<Error | null>(null);
async function submit(input: CreateMatchWithMediaInput) {
   try {
      const match = await setup.create(input.match);
      await mediaSources.create(match.id, input.media);
      await router.push(`/annotate/${match.id}`);
   } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error("場次建立失敗");
   }
}
</script>

<template>
   <section class="space-y-6">
      <header>
         <p
            class="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700"
         >
            新場次
         </p>
         <h1 class="mt-2 text-3xl font-semibold tracking-tight">
            建立比賽資料
         </h1>
         <p class="mt-2 max-w-3xl text-stone-600">
            一次提交場次、兩側隊伍與 roster；伺服器會以單一 transaction
            建立完整關聯。
         </p>
      </header>
      <MatchSetupForm
         :pending="setup.pending.value"
         :error="error ?? setup.error.value"
         @submit="submit"
         @cancel="router.back()"
      />
   </section>
</template>
