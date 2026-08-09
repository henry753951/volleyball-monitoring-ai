<script setup lang="ts">
import { CircleAlert, Database, ShieldCheck } from "lucide-vue-next";
import {
   createCoachDomainClient,
   type CoachMatchAnalytics,
   type CoachMetric,
} from "~/lib/coachDomain";
import { createGraphQLTransport } from "~/lib/coreDomain";
const route = useRoute();
const matchId = computed(() => String(route.params.matchId));
const analytics = shallowRef<CoachMatchAnalytics | null>(null);
const pending = ref(true);
const error = shallowRef<Error | null>(null);
onMounted(async () => {
   try {
      analytics.value = await createCoachDomainClient(
         createGraphQLTransport("/graphql"),
      ).analytics(matchId.value);
   } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error("無法載入統計");
   } finally {
      pending.value = false;
   }
});
const labels: Record<string, string> = {
   rally_count: "Rally 數",
   resolved_rally_win_rate: "已解析 outcome 覆蓋率",
   contact_event_count: "Contact events",
   participant_event_count: "Participant events",
   court_position_samples: "Court position samples",
   complete_path_rate: "完整球路比例",
   identity_coverage: "Identity 覆蓋率",
   action_samples: "Action samples",
};
function value(key: string, metric: CoachMetric) {
   return key.endsWith("_rate") || key.endsWith("_coverage")
      ? `${(metric.value * 100).toFixed(1)}%`
      : new Intl.NumberFormat("zh-TW").format(metric.value);
}
</script>

<template>
   <section class="space-y-4">
      <header>
         <p class="text-sm text-stone-500">
            {{ analytics?.match.title || `Match ${matchId}` }}
         </p>
         <h1 class="text-2xl font-semibold tracking-tight">統計與資料品質</h1>
         <p class="mt-1 max-w-3xl text-sm text-stone-600">
            每個指標都附 sample、excluded、unknown 與 feature
            dependencies；不以「Rally 最後得分」偽裝事件直接得分。
         </p>
      </header>
      <div
         v-if="pending"
         class="h-56 animate-pulse rounded-2xl bg-stone-200"
         aria-busy="true"
      />
      <div
         v-else-if="error"
         class="rounded-2xl bg-rose-50 p-6 text-rose-900"
         role="alert"
      >
         <p class="flex items-center gap-2 font-semibold">
            <CircleAlert class="size-5" />統計載入失敗
         </p>
         <p class="mt-2 text-sm">{{ error.message }}</p>
      </div>
      <template v-else-if="analytics">
         <div class="flex flex-wrap gap-2">
            <span
               class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-sm shadow-sm"
               ><ShieldCheck class="size-4 text-teal-700" />Identity
               {{
                  analytics.feature_availability.identity
                     ? "available"
                     : "unavailable"
               }}</span
            ><span
               class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-sm shadow-sm"
               ><Database class="size-4 text-teal-700" />Court positions
               {{
                  analytics.feature_availability.court_positions
                     ? "available"
                     : "unavailable"
               }}</span
            ><span
               class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-sm shadow-sm"
               >Action
               {{
                  analytics.feature_availability.action
                     ? "available"
                     : "unavailable"
               }}</span
            >
         </div>
         <section class="overflow-x-auto rounded-2xl bg-white shadow-sm">
            <table class="w-full min-w-[760px] text-left text-sm">
               <thead class="bg-stone-100 text-stone-600">
                  <tr>
                     <th class="px-4 py-3">Metric</th>
                     <th class="px-4 py-3">Value</th>
                     <th class="px-4 py-3">Samples</th>
                     <th class="px-4 py-3">Excluded</th>
                     <th class="px-4 py-3">Unknown</th>
                     <th class="px-4 py-3">Dependencies</th>
                  </tr>
               </thead>
               <tbody>
                  <tr
                     v-for="(metric, key) in analytics.metrics"
                     :key="key"
                     class="border-t border-stone-100"
                  >
                     <th class="px-4 py-4 font-semibold">
                        {{ labels[key] || key }}
                     </th>
                     <td class="px-4 py-4 text-lg font-semibold">
                        {{ value(String(key), metric) }}
                     </td>
                     <td class="px-4 py-4">{{ metric.sample_count }}</td>
                     <td class="px-4 py-4">{{ metric.excluded_count }}</td>
                     <td class="px-4 py-4">{{ metric.unknown_count }}</td>
                     <td class="px-4 py-4 text-stone-500">
                        {{ metric.feature_dependencies.join(" · ") }}
                     </td>
                  </tr>
               </tbody>
            </table>
         </section>
         <section class="rounded-2xl bg-white p-5 shadow-sm">
            <h2 class="font-semibold">Team rally outcomes</h2>
            <div class="mt-4 grid gap-3 sm:grid-cols-2">
               <article
                  v-for="team in analytics.teams"
                  :key="team.id"
                  class="rounded-xl bg-stone-100 p-4"
               >
                  <p class="font-semibold">{{ team.name }}</p>
                  <p class="mt-2 text-sm text-stone-600">
                     {{ team.wins }} wins · {{ team.losses }} losses ·
                     {{ team.unknown }} unknown
                  </p>
                  <p class="mt-1 text-xs text-stone-500">
                     resolved sample {{ team.sample_count }}
                  </p>
               </article>
            </div>
         </section>
         <p
            v-if="!analytics.feature_availability.action"
            class="rounded-xl bg-amber-50 p-4 text-sm text-amber-950"
         >
            Provider 尚未提供 action extension，因此不顯示
            attack／serve／efficiency 等衍生指標。
         </p>
      </template>
   </section>
</template>
