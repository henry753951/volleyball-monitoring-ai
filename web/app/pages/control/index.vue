<script setup lang="ts">
import {
   Activity,
   AlertTriangle,
   Braces,
   CircleDot,
   Clock3,
   Copy,
   Database,
   HardDrive,
   KeyRound,
   MemoryStick,
   Plus,
   RefreshCw,
   RotateCw,
   Search,
   Server,
   ShieldCheck,
   Wifi,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import type { DeepReadonly } from "vue";
import MediaDvrMonitorDialog from "~/components/control/MediaDvrMonitorDialog.vue";
import StorageMeter from "~/components/control/StorageMeter.vue";
import type { Match } from "~/lib/coreDomain";
import type { CreateMatchWithMediaInput } from "~/lib/mediaSourceClient";
import { createMediaSourceClient } from "~/lib/mediaSourceClient";
import {
   activeAiWorkForDashboard,
   createAiWorkerToken,
   deleteAiWorker,
   deleteAiWorkerToken,
   rotateAiWorkerToken,
   setAiWorkerTokenEnabled,
   visibleStreamsForMatches,
   type AiWorkerSnapshot,
   type AiWorkerTokenSnapshot,
   type MetricGroup,
} from "~/lib/operationsMonitor";

definePageMeta({ layout: "control" });

type ControlView = "overview" | "matches" | "systems" | "workers";
type Tone = "good" | "warning" | "danger" | "neutral";

const route = useRoute();
const router = useRouter();
const runtimeConfig = useRuntimeConfig();
const matchesState = useMatches();
const setup = useCreateMatchSetup();
const core = useCoreDomain();
const monitor = useOperationsMonitor();
const mediaSources = createMediaSourceClient();

const search = ref("");
const createOpen = ref(false);
const createError = shallowRef<Error | null>(null);
const createdMatchId = ref<string | null>(null);
const sourceMatch = shallowRef<Match | null>(null);
const rosterMatch = shallowRef<Match | null>(null);
const sourceDialogOpen = ref(false);
const rosterDialogOpen = ref(false);
const editMatch = shallowRef<DeepReadonly<Match> | null>(null);
const deleteTarget = shallowRef<DeepReadonly<Match> | null>(null);
const editOpen = ref(false);
const deleteOpen = ref(false);
const editPending = ref(false);
const deletePending = ref(false);
const editError = shallowRef<Error | null>(null);
const deleteError = shallowRef<Error | null>(null);
const workerDeleteTarget = shallowRef<AiWorkerSnapshot | null>(null);
const workerDeletePending = ref(false);
const workerDeleteError = shallowRef<Error | null>(null);
const mediaMonitorMatch = shallowRef<DeepReadonly<Match> | null>(null);

const tokenDialogOpen = ref(false);
const tokenName = ref("");
const tokenPending = ref(false);
const tokenError = ref("");
const revealedToken = ref("");
const rotatingToken = shallowRef<DeepReadonly<AiWorkerTokenSnapshot> | null>(
   null,
);
const tokenDeleteTarget =
   shallowRef<DeepReadonly<AiWorkerTokenSnapshot> | null>(null);
const tokenDeletePending = ref(false);
const tokenDeleteError = shallowRef<Error | null>(null);
let revokedWorkerRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const view = computed<ControlView>(() => {
   const requested =
      typeof route.query.view === "string" ? route.query.view : "overview";
   if (requested === "media") return "matches";
   if (requested === "ai") return "workers";
   return ["matches", "systems", "workers"].includes(requested)
      ? (requested as ControlView)
      : "overview";
});
const viewMeta: Record<ControlView, { title: string; detail: string }> = {
   overview: { title: "運行總覽", detail: "場次工作區與核心服務" },
   matches: {
      title: "場次工作區",
      detail: "每場賽事的媒體、DVR 與 AI 處理狀態",
   },
   systems: { title: "系統狀態", detail: "服務相依性、同步與主機資源" },
   workers: { title: "AI Workers", detail: "連線、Token 與執行狀態" },
};

const filteredMatches = computed(() => {
   const value = search.value.trim().toLocaleLowerCase();
   if (!value) return matchesState.matches.value;
   return matchesState.matches.value.filter((match) =>
      [
         match.title,
         match.venue,
         ...match.teams.flatMap((team) => [team.name, team.shortName]),
      ].some((item) => item?.toLocaleLowerCase().includes(value)),
   );
});
const database = computed(() => monitor.snapshot.value?.operations.database);
const aiWorkers = computed(
   () => monitor.snapshot.value?.operations.aiWorkers ?? [],
);
const aiWorkerAccess = computed(
   () => monitor.snapshot.value?.operations.aiWorkerAccess ?? null,
);
const aiWorkerTokens = computed(() => aiWorkerAccess.value?.tokens ?? []);
const aiWork = computed(() => monitor.snapshot.value?.operations.aiWork ?? []);
const activeAiWork = computed(() => activeAiWorkForDashboard(aiWork.value));
const visibleMatchIds = computed(
   () => new Set(matchesState.matches.value.map((match) => match.id)),
);
const streams = computed(() =>
   visibleStreamsForMatches(
      monitor.snapshot.value?.operations.streams ?? [],
      visibleMatchIds.value,
   ),
);
const streamsByMatch = computed(() =>
   Map.groupBy(streams.value, (stream) => stream.matchId),
);
const jobsByMatch = computed(() =>
   Map.groupBy(activeAiWork.value, (job) => job.matchId),
);
const generatedAt = computed(
   () => monitor.snapshot.value?.operations.generatedAt ?? null,
);
const hostStorage = computed(
   () => monitor.snapshot.value?.operations.hostStorage ?? null,
);
const objectStorage = computed(
   () => monitor.snapshot.value?.operations.objectStorage ?? null,
);
const matchMediaById = computed(
   () =>
      new Map(
         (monitor.snapshot.value?.operations.matchMedia ?? []).map((item) => [
            item.matchId,
            item,
         ]),
      ),
);
const totalMediaBytes = computed(() =>
   (monitor.snapshot.value?.operations.matchMedia ?? []).reduce(
      (total, item) => total + BigInt(item.storedBytes),
      0n,
   ),
);
function sum(
   groups: readonly MetricGroup[] | undefined,
   labels: Record<string, string | string[]> = {},
) {
   if (!groups) return 0;
   return groups
      .filter((group) =>
         Object.entries(labels).every(([key, expected]) => {
            const values = Array.isArray(expected) ? expected : [expected];
            return values.includes(group.labels[key] ?? "");
         }),
      )
      .reduce((total, group) => total + group.count, 0);
}
function all(groups: readonly MetricGroup[] | undefined) {
   return groups?.reduce((total, group) => total + group.count, 0) ?? 0;
}
function formatBytes(value: number | string | bigint) {
   const amount = Number(value);
   if (!Number.isFinite(amount) || amount <= 0) return "0 B";
   const units = ["B", "KB", "MB", "GB", "TB"];
   const index = Math.min(
      Math.floor(Math.log(amount) / Math.log(1024)),
      units.length - 1,
   );
   return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function formatSeconds(value: number) {
   if (!Number.isFinite(value)) return "—";
   const hours = Math.floor(value / 3600);
   const minutes = Math.floor((value % 3600) / 60);
   return hours ? `${hours} 小時 ${minutes} 分` : `${minutes} 分`;
}
function formatTime(value: string | null) {
   if (!value) return "尚未同步";
   return new Intl.DateTimeFormat("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
   }).format(new Date(value));
}
function readiness(name: string) {
   return monitor.snapshot.value?.readiness.checks[name] ?? null;
}

const liveStreams = computed(
   () => streams.value.filter((stream) => stream.status === "LIVE").length,
);
const unhealthyStreams = computed(
   () =>
      streams.value.filter(
         (stream) =>
            ["DEGRADED", "OFFLINE"].includes(stream.health) ||
            stream.status === "FAILED",
      ).length,
);
const aiActive = computed(() =>
   sum(database.value?.aiJobs, {
      status: ["PENDING", "QUEUED", "RUNNING", "PROCESSING"],
   }),
);
const systemRows = computed(
   () =>
      [
         {
            name: "控制介面",
            detail: "管理工作站",
            value: monitor.error.value
               ? "無法連線"
               : monitor.snapshot.value
                 ? "已連線"
                 : "連線中",
            tone: monitor.error.value
               ? "danger"
               : monitor.snapshot.value
                 ? "good"
                 : "warning",
            icon: Braces,
         },
         {
            name: "核心 API",
            detail: `程序運行 ${formatSeconds(monitor.snapshot.value?.operations.process.uptimeSeconds ?? 0)}`,
            value:
               monitor.snapshot.value?.readiness.status === "ready"
                  ? "服務正常"
                  : "服務降級",
            tone:
               monitor.snapshot.value?.readiness.status === "ready"
                  ? "good"
                  : "danger",
            icon: Server,
         },
         {
            name: "PostgreSQL",
            detail: `${all(database.value?.rallies)} 個回合 · ${database.value?.annotationOperations.total ?? 0} 次標註操作`,
            value: readiness("postgres") === "ok" ? "正常" : "異常",
            tone: readiness("postgres") === "ok" ? "good" : "danger",
            icon: Database,
         },
         {
            name: "Redis / 即時同步",
            detail: `${all(database.value?.outboxEvents)} 筆事件 · ${sum(database.value?.outboxEvents, { status: "PENDING" })} 筆待送`,
            value: readiness("redis") === "ok" ? "正常" : "異常",
            tone: readiness("redis") === "ok" ? "good" : "danger",
            icon: Wifi,
         },
         {
            name: "S3 物件儲存",
            detail: `${all(database.value?.mediaAssets)} 個媒體資產`,
            value: readiness("minio") === "ok" ? "正常" : "異常",
            tone: readiness("minio") === "ok" ? "good" : "danger",
            icon: HardDrive,
         },
      ] as Array<{
         name: string;
         detail: string;
         value: string;
         tone: Tone;
         icon: typeof Server;
      }>,
);

async function openSource(matchId: string) {
   sourceMatch.value = await core.match(matchId);
   sourceDialogOpen.value = true;
}
async function openRoster(matchId: string) {
   rosterMatch.value = await core.match(matchId);
   rosterDialogOpen.value = true;
}
function openEdit(match: DeepReadonly<Match>) {
   editMatch.value = match;
   editError.value = null;
   editOpen.value = true;
}
function openDelete(match: DeepReadonly<Match>) {
   deleteTarget.value = match;
   deleteError.value = null;
   deleteOpen.value = true;
}
function openMediaMonitor(match: DeepReadonly<Match>) {
   mediaMonitorMatch.value = match;
}
async function saveMatch(input: Parameters<typeof core.updateMatch>[0]) {
   editPending.value = true;
   editError.value = null;
   try {
      await core.updateMatch(input);
      editOpen.value = false;
      await matchesState.refresh();
      toast.success("場次資料已更新");
   } catch (error) {
      editError.value =
         error instanceof Error ? error : new Error("場次更新失敗");
   } finally {
      editPending.value = false;
   }
}
async function confirmDelete() {
   if (!deleteTarget.value) return;
   deletePending.value = true;
   deleteError.value = null;
   try {
      await core.deleteMatch(deleteTarget.value.id);
      deleteOpen.value = false;
      deleteTarget.value = null;
      await matchesState.refresh();
      void monitor.refresh();
      toast.success("場次已移除，採集工作與媒體正在背景清理");
   } catch (error) {
      deleteError.value =
         error instanceof Error ? error : new Error("場次刪除失敗");
   } finally {
      deletePending.value = false;
   }
}
function openWorkerDelete(worker: AiWorkerSnapshot) {
   if (worker.canDelete) {
      workerDeleteTarget.value = worker;
      workerDeleteError.value = null;
   }
}
async function confirmWorkerDelete() {
   if (!workerDeleteTarget.value) return;
   workerDeletePending.value = true;
   workerDeleteError.value = null;
   try {
      const receipt = await deleteAiWorker(
         runtimeConfig.public.restBasePath,
         workerDeleteTarget.value.id,
      );
      workerDeleteTarget.value = null;
      await monitor.refresh();
      toast.success(`已移除 ${receipt.deleted_worker.instance_key}`);
   } catch (error) {
      workerDeleteError.value =
         error instanceof Error ? error : new Error("AI Worker 刪除失敗");
      await monitor.refresh();
   } finally {
      workerDeletePending.value = false;
   }
}
function closeRoster() {
   rosterDialogOpen.value = false;
   if (route.query.match)
      void router.replace({
         path: "/control",
         query: view.value === "overview" ? {} : { view: view.value },
      });
}
function closeCreate() {
   createOpen.value = false;
   createError.value = null;
   createdMatchId.value = null;
}
async function submit(input: CreateMatchWithMediaInput) {
   try {
      if (!createdMatchId.value)
         createdMatchId.value = (await setup.create(input.match)).id;
      await mediaSources.create(createdMatchId.value, input.media);
      closeCreate();
      await Promise.all([matchesState.refresh(), monitor.refresh()]);
   } catch (error) {
      createError.value =
         error instanceof Error ? error : new Error("場次建立失敗");
   }
}

function openTokenCreate() {
   rotatingToken.value = null;
   tokenName.value = "";
   tokenError.value = "";
   revealedToken.value = "";
   tokenDialogOpen.value = true;
}
async function createToken() {
   tokenPending.value = true;
   tokenError.value = "";
   try {
      const result = await createAiWorkerToken(
         runtimeConfig.public.restBasePath,
         tokenName.value,
      );
      revealedToken.value = result.token;
      await monitor.refresh();
   } catch (error) {
      tokenError.value =
         error instanceof Error ? error.message : "Token 建立失敗";
   } finally {
      tokenPending.value = false;
   }
}
async function rotateToken(token: DeepReadonly<AiWorkerTokenSnapshot>) {
   rotatingToken.value = token;
   tokenName.value = token.name;
   tokenError.value = "";
   revealedToken.value = "";
   tokenDialogOpen.value = true;
   tokenPending.value = true;
   try {
      revealedToken.value = (
         await rotateAiWorkerToken(runtimeConfig.public.restBasePath, token.id)
      ).token;
      await monitor.refresh();
   } catch (error) {
      tokenError.value =
         error instanceof Error ? error.message : "Token 更新失敗";
   } finally {
      tokenPending.value = false;
   }
}
async function toggleToken(token: DeepReadonly<AiWorkerTokenSnapshot>) {
   try {
      await setAiWorkerTokenEnabled(
         runtimeConfig.public.restBasePath,
         token.id,
         !token.enabled,
      );
      await monitor.refresh();
      toast.success(token.enabled ? "Token 已停用" : "Token 已啟用");
   } catch (error) {
      toast.error(error instanceof Error ? error.message : "Token 更新失敗");
   }
}
function openTokenDelete(token: DeepReadonly<AiWorkerTokenSnapshot>) {
   tokenDeleteTarget.value = token;
   tokenDeleteError.value = null;
}
async function confirmTokenDelete() {
   const token = tokenDeleteTarget.value;
   if (!token) return;
   tokenDeletePending.value = true;
   tokenDeleteError.value = null;
   try {
      await deleteAiWorkerToken(runtimeConfig.public.restBasePath, token.id);
      tokenDeleteTarget.value = null;
      await monitor.refresh();
      toast.success(
         `已刪除「${token.name}」；使用中的本機 Worker 將在下一次心跳退出`,
      );
      if (revokedWorkerRefreshTimer) clearTimeout(revokedWorkerRefreshTimer);
      revokedWorkerRefreshTimer = setTimeout(() => {
         void monitor.refresh();
      }, 11_000);
   } catch (error) {
      tokenDeleteError.value =
         error instanceof Error ? error : new Error("Token 刪除失敗");
   } finally {
      tokenDeletePending.value = false;
   }
}
async function copy(value: string) {
   await navigator.clipboard.writeText(value);
   toast.success("已複製到剪貼簿");
}
function websocketEndpoint() {
   if (!import.meta.client) return "/api/v1/ai/providers/ws";
   const protocol = location.protocol === "https:" ? "wss:" : "ws:";
   const authority =
      location.protocol === "https:"
         ? location.host
         : `${location.hostname}:4000`;
   return `${protocol}//${authority}/api/v1/ai/providers/ws`;
}

onMounted(async () => {
   await matchesState.refresh();
   const requestedMatch =
      typeof route.query.match === "string" ? route.query.match : null;
   if (requestedMatch) await openRoster(requestedMatch);
});
onBeforeUnmount(() => {
   if (revokedWorkerRefreshTimer) clearTimeout(revokedWorkerRefreshTimer);
});
</script>

<template>
   <section class="control-page">
      <header class="page-header">
         <div>
            <h1>{{ viewMeta[view].title }}</h1>
            <p>{{ viewMeta[view].detail }}</p>
         </div>
         <div class="page-header__sync">
            <span
               ><i :class="{ danger: monitor.error.value }" />{{
                  monitor.error.value
                     ? "同步中斷"
                     : `更新於 ${formatTime(generatedAt)}`
               }}</span
            ><button
               type="button"
               :disabled="monitor.pending.value"
               aria-label="立即重新整理"
               @click="monitor.refresh"
            >
               <RefreshCw
                  :size="15"
                  :class="{ spinning: monitor.pending.value }"
               />
            </button>
         </div>
      </header>

      <div
         v-if="monitor.error.value"
         class="monitor-error"
         role="alert"
      >
         <AlertTriangle :size="17" /><span
            ><strong>監控資料暫時無法更新</strong
            >{{ monitor.error.value.message }}</span
         ><button
            type="button"
            @click="monitor.refresh"
         >
            重新連線
         </button>
      </div>

      <div
         v-if="view === 'overview'"
         class="view-panel"
      >
         <section class="ops-command">
            <div class="ops-health">
               <i
                  :class="
                     monitor.snapshot.value?.readiness.status === 'ready'
                        ? 'good'
                        : 'danger'
                  "
               />
               <div>
                  <strong>{{
                     monitor.snapshot.value?.readiness.status === "ready"
                        ? "所有核心服務正常"
                        : "服務降級"
                  }}</strong
                  ><small>中央系統即時健康檢查</small>
               </div>
            </div>
            <dl>
               <div>
                  <dt>場次</dt>
                  <dd>{{ matchesState.matches.value.length }}</dd>
               </div>
               <div>
                  <dt>運行中輸入</dt>
                  <dd>
                     {{ liveStreams }}<small>/ {{ streams.length }}</small>
                  </dd>
               </div>
               <div>
                  <dt>AI 作業</dt>
                  <dd>{{ aiActive }}</dd>
               </div>
               <div>
                  <dt>媒體用量</dt>
                  <dd>{{ formatBytes(totalMediaBytes) }}</dd>
               </div>
            </dl>
         </section>
         <div class="storage-overview">
            <StorageMeter
               label="S3 物件儲存"
               kind="object"
               :storage="objectStorage"
               :detail="`MinIO · ${objectStorage?.path ?? ''}`"
            />
            <StorageMeter
               label="Server 暫存空間"
               kind="temporary"
               :storage="hostStorage"
               :detail="hostStorage?.path ?? ''"
            />
         </div>
         <div class="section-title">
            <div>
               <h2>場次工作區</h2>
               <p>媒體與分析狀態均以場次為單位</p>
            </div>
            <NuxtLink :to="{ path: '/control', query: { view: 'matches' } }"
               >管理全部</NuxtLink
            >
         </div>
         <div class="match-grid overview-matches">
            <ControlMatchWorkspaceCard
               v-for="match in matchesState.matches.value.slice(0, 2)"
               :key="match.id"
               :match="match"
               :media="matchMediaById.get(match.id) ?? null"
               :streams="streamsByMatch.get(match.id) ?? []"
               :jobs="jobsByMatch.get(match.id) ?? []"
               @media="openSource(match.id)"
               @monitor="openMediaMonitor(match)"
               @roster="openRoster(match.id)"
               @edit="openEdit(match)"
               @delete="openDelete(match)"
            />
         </div>
      </div>

      <div
         v-else-if="view === 'matches'"
         class="view-panel"
      >
         <div class="control-actions">
            <label
               ><Search :size="16" /><input
                  v-model="search"
                  placeholder="搜尋場次或隊伍" /></label
            ><button
               type="button"
               class="primary-action"
               @click="createOpen = true"
            >
               <Plus :size="16" />新增場次
            </button>
         </div>
         <div
            v-if="matchesState.pending.value"
            class="match-loading"
         />
         <div
            v-else-if="!filteredMatches.length"
            class="empty-state"
         >
            <CircleDot :size="22" /><strong>沒有符合的場次</strong
            ><span>調整搜尋條件或新增場次</span>
         </div>
         <div
            v-else
            class="match-grid"
         >
            <ControlMatchWorkspaceCard
               v-for="match in filteredMatches"
               :key="match.id"
               :match="match"
               :media="matchMediaById.get(match.id) ?? null"
               :streams="streamsByMatch.get(match.id) ?? []"
               :jobs="jobsByMatch.get(match.id) ?? []"
               @media="openSource(match.id)"
               @monitor="openMediaMonitor(match)"
               @roster="openRoster(match.id)"
               @edit="openEdit(match)"
               @delete="openDelete(match)"
            />
         </div>
      </div>

      <div
         v-else-if="view === 'systems'"
         class="view-panel systems-view"
      >
         <section class="workspace-section">
            <div class="section-title compact">
               <div>
                  <h2>服務拓樸</h2>
                  <p>中央系統與基礎服務</p>
               </div>
            </div>
            <div class="system-grid">
               <article
                  v-for="service in systemRows"
                  :key="service.name"
               >
                  <span
                     ><component
                        :is="service.icon"
                        :size="17"
                  /></span>
                  <div>
                     <strong>{{ service.name }}</strong
                     ><small>{{ service.detail }}</small>
                  </div>
                  <em :class="service.tone"><i />{{ service.value }}</em>
               </article>
            </div>
         </section>
         <section class="workspace-section runtime">
            <div class="section-title compact">
               <div>
                  <h2>API 程序資源</h2>
                  <p>目前 Fastify 服務程序</p>
               </div>
            </div>
            <dl>
               <div>
                  <dt><MemoryStick :size="15" />常駐記憶體</dt>
                  <dd>
                     {{
                        formatBytes(
                           monitor.snapshot.value?.operations.process
                              .residentBytes ?? 0,
                        )
                     }}
                  </dd>
               </div>
               <div>
                  <dt><Activity :size="15" />JavaScript Heap</dt>
                  <dd>
                     {{
                        formatBytes(
                           monitor.snapshot.value?.operations.process
                              .heapUsedBytes ?? 0,
                        )
                     }}
                  </dd>
               </div>
               <div>
                  <dt><Clock3 :size="15" />運行時間</dt>
                  <dd>
                     {{
                        formatSeconds(
                           monitor.snapshot.value?.operations.process
                              .uptimeSeconds ?? 0,
                        )
                     }}
                  </dd>
               </div>
               <div>
                  <dt><CircleDot :size="15" />標註命令</dt>
                  <dd>{{ all(database?.annotationReceipts) }}</dd>
               </div>
            </dl>
         </section>
      </div>

      <div
         v-else
         class="view-panel workers-view"
      >
         <ControlAiWorkerConsole
            :active-jobs="aiWorkerAccess?.activeJobCount ?? 0"
            :endpoint="websocketEndpoint()"
            :tokens="aiWorkerTokens"
            :workers="aiWorkers"
            @copy="copy"
            @create-token="openTokenCreate"
            @delete-token="openTokenDelete"
            @delete-worker="openWorkerDelete"
            @rotate-token="rotateToken"
            @toggle-token="toggleToken"
         />
      </div>

      <UiAnimatedModal
         :open="createOpen"
         title="新增場次"
         description="設定隊伍、名單與影音來源"
         width="wide"
         @close="closeCreate"
         ><UiScrollArea class="create-scroll"
            ><div class="create-content">
               <MatchSetupForm
                  :pending="setup.pending.value"
                  :error="createError ?? setup.error.value"
                  compact
                  @submit="submit"
                  @cancel="closeCreate"
               /></div></UiScrollArea
      ></UiAnimatedModal>
      <LazyCaptureControlDialog
         v-if="sourceMatch"
         :open="sourceDialogOpen"
         :match-id="sourceMatch.id"
         :captures="sourceMatch.captureSessions ?? []"
         @close="sourceDialogOpen = false"
         @changed="matchesState.refresh"
      />
      <LazyRosterEditorDialog
         v-if="rosterMatch"
         :open="rosterDialogOpen"
         :match="rosterMatch"
         @close="closeRoster"
         @changed="matchesState.refresh"
      />
      <ControlMatchEditorDialog
         :open="editOpen"
         :match="editMatch"
         :pending="editPending"
         :error="editError"
         @close="editOpen = false"
         @save="saveMatch"
      />
      <ControlMatchDeleteDialog
         :open="deleteOpen"
         :match="deleteTarget"
         :media="
            deleteTarget ? (matchMediaById.get(deleteTarget.id) ?? null) : null
         "
         :pending="deletePending"
         :error="deleteError"
         @close="deleteOpen = false"
         @confirm="confirmDelete"
      />
      <ControlAiWorkerDeleteDialog
         :open="Boolean(workerDeleteTarget)"
         :worker="workerDeleteTarget"
         :pending="workerDeletePending"
         :error="workerDeleteError"
         @close="workerDeleteTarget = null"
         @confirm="confirmWorkerDelete"
      />
      <ControlAiWorkerTokenDeleteDialog
         :open="Boolean(tokenDeleteTarget)"
         :token="tokenDeleteTarget"
         :pending="tokenDeletePending"
         :error="tokenDeleteError"
         @close="tokenDeleteTarget = null"
         @confirm="confirmTokenDelete"
      />
      <MediaDvrMonitorDialog
         :open="Boolean(mediaMonitorMatch)"
         :match-title="mediaMonitorMatch?.title ?? ''"
         :media="
            mediaMonitorMatch
               ? (matchMediaById.get(mediaMonitorMatch.id) ?? null)
               : null
         "
         :streams="
            mediaMonitorMatch
               ? (streamsByMatch.get(mediaMonitorMatch.id) ?? [])
               : []
         "
         @close="mediaMonitorMatch = null"
      />

      <UiAnimatedModal
         :open="tokenDialogOpen"
         :title="rotatingToken ? '輪替 Worker Token' : '建立 Worker Token'"
         :description="
            revealedToken
               ? '請立即複製；關閉後無法再次查看。'
               : '供 volleyball-analysis-engine 連入中央系統。'
         "
         @close="tokenDialogOpen = false"
      >
         <div class="token-dialog">
            <template v-if="revealedToken"
               ><label>新的存取 Token</label>
               <div class="revealed-token">
                  <code>{{ revealedToken }}</code
                  ><button
                     type="button"
                     @click="copy(revealedToken)"
                  >
                     <Copy :size="15" />複製
                  </button>
               </div>
               <p><ShieldCheck :size="14" />伺服器只保存 SHA-256 hash。</p>
               <button
                  type="button"
                  class="dialog-primary"
                  @click="tokenDialogOpen = false"
               >
                  完成
               </button></template
            >
            <template v-else-if="rotatingToken"
               ><div class="rotating">
                  <RotateCw
                     :size="20"
                     :class="{ spinning: tokenPending }"
                  /><strong>{{
                     tokenPending
                        ? "正在產生新 Token…"
                        : tokenError || "準備輪替"
                  }}</strong
                  ><small>舊 Token 會立即失效</small>
               </div></template
            >
            <template v-else
               ><label for="token-name">Token 名稱</label
               ><input
                  id="token-name"
                  v-model="tokenName"
                  placeholder="例如：GPU 工作站 A"
                  maxlength="64"
                  @keyup.enter="createToken"
               />
               <p
                  v-if="tokenError"
                  class="dialog-error"
               >
                  {{ tokenError }}
               </p>
               <button
                  type="button"
                  class="dialog-primary"
                  :disabled="tokenPending || !tokenName.trim()"
                  @click="createToken"
               >
                  <KeyRound :size="15" />{{
                     tokenPending ? "建立中…" : "建立 Token"
                  }}
               </button></template
            >
         </div>
      </UiAnimatedModal>
   </section>
</template>

<style scoped>
.control-page {
   min-height: 100%;
   background: #0a0b0d;
   color: #f2f3f5;
}
.page-header {
   position: sticky;
   top: 0;
   z-index: 30;
   height: 58px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 0 24px;
   border-bottom: 1px solid #282a2e;
   background: #0d0e10ed;
   backdrop-filter: blur(12px);
}
.page-header h1 {
   margin: 0;
   font-size: 0.85rem;
}
.page-header p {
   margin: 3px 0 0;
   color: #7e8187;
   font-size: 0.56rem;
}
.page-header__sync {
   display: flex;
   align-items: center;
   gap: 10px;
}
.page-header__sync span {
   display: flex;
   align-items: center;
   gap: 6px;
   color: #7d8086;
   font-size: 0.55rem;
}
.page-header__sync span i {
   width: 6px;
   height: 6px;
   border-radius: 50%;
   background: #4bc28a;
}
.page-header__sync span i.danger {
   background: #df706d;
}
.page-header__sync button {
   width: 32px;
   height: 32px;
   display: grid;
   place-items: center;
   border: 1px solid #34363b;
   border-radius: 8px;
   background: #181a1e;
   color: #aeb1b6;
}
.spinning {
   animation: spin 0.8s linear infinite;
}
@keyframes spin {
   to {
      transform: rotate(360deg);
   }
}
.monitor-error {
   display: flex;
   align-items: center;
   gap: 10px;
   margin: 14px 24px 0;
   padding: 10px 12px;
   border: 1px solid #5d3535;
   border-radius: 9px;
   background: #251617;
   color: #df9b98;
   font-size: 0.6rem;
}
.monitor-error span {
   display: grid;
   gap: 2px;
}
.monitor-error button {
   margin-left: auto;
   border: 0;
   background: transparent;
   color: #fff;
}
.view-panel {
   width: min(100%, 1500px);
   margin: auto;
   padding: 18px 24px 40px;
}
.ops-command {
   display: grid;
   grid-template-columns: minmax(260px, 0.75fr) minmax(500px, 1.25fr);
   overflow: hidden;
   border: 1px solid #2b2d31;
   border-radius: 12px;
   background: #111216;
}
.ops-health {
   display: flex;
   align-items: center;
   gap: 12px;
   padding: 14px 17px;
   border-right: 1px solid #2b2d31;
}
.ops-health > i {
   width: 9px;
   height: 9px;
   border-radius: 50%;
}
.ops-health > i.good {
   background: #47c187;
}
.ops-health > i.danger {
   background: #dc706d;
}
.ops-health > div {
   display: grid;
   gap: 3px;
}
.ops-health strong {
   font-size: 0.68rem;
}
.ops-health small {
   color: #777a80;
   font-size: 0.54rem;
}
.ops-command dl {
   display: grid;
   grid-template-columns: repeat(4, 1fr);
   margin: 0;
}
.ops-command dl > div {
   display: grid;
   align-content: center;
   gap: 5px;
   padding: 0 14px;
   border-left: 1px solid #292b2f;
}
.ops-command dt {
   color: #777a80;
   font-size: 0.52rem;
}
.ops-command dd {
   display: flex;
   align-items: baseline;
   gap: 4px;
   margin: 0;
   font-size: 0.92rem;
   font-weight: 760;
}
.ops-command dd small {
   color: #6c7076;
   font-size: 0.5rem;
}
.storage-overview {
   margin: 10px 0 18px;
   overflow: hidden;
   border: 1px solid #292b30;
   border-radius: 12px;
   background: #0f1012;
}
.section-title {
   min-height: 48px;
   display: flex;
   align-items: center;
   justify-content: space-between;
}
.section-title h2 {
   margin: 0;
   font-size: 0.72rem;
}
.section-title p {
   margin: 3px 0 0;
   color: #777a80;
   font-size: 0.54rem;
}
.section-title > a {
   color: #b4b7bc;
   font-size: 0.57rem;
   text-decoration: none;
}
.section-title.compact {
   min-height: 54px;
   padding: 0 16px;
   border-bottom: 1px solid #292b30;
}
.section-title > span {
   color: #777a80;
   font-size: 0.54rem;
}
.match-grid {
   display: grid;
   grid-template-columns: repeat(2, minmax(0, 1fr));
   gap: 14px;
}
.overview-matches {
   margin-bottom: 22px;
}
.control-actions {
   position: sticky;
   top: 58px;
   z-index: 25;
   display: flex;
   justify-content: space-between;
   gap: 12px;
   padding: 8px 0 14px;
   background: #0a0b0df2;
   backdrop-filter: blur(10px);
}
.control-actions label {
   width: min(420px, 55vw);
   height: 36px;
   display: flex;
   align-items: center;
   gap: 8px;
   padding: 0 11px;
   border: 1px solid #34363b;
   border-radius: 8px;
   background: #131519;
   color: #7d8086;
}
.control-actions input {
   width: 100%;
   border: 0;
   outline: 0;
   background: transparent;
   color: #f1f2f4;
   font-size: 0.63rem;
}
.primary-action,
.worker-command button,
.pool-grid header button {
   height: 36px;
   display: flex;
   align-items: center;
   justify-content: center;
   gap: 7px;
   padding: 0 13px;
   border: 1px solid #e2e3e5;
   border-radius: 8px;
   background: #f2f3f4;
   color: #111216;
   font-size: 0.62rem;
   font-weight: 750;
}
.match-loading {
   height: 320px;
   border: 1px solid #292b30;
   border-radius: 14px;
   background: linear-gradient(90deg, #111216 20%, #181a1e 50%, #111216 80%);
   background-size: 200% 100%;
   animation: loading 1.2s infinite;
}
@keyframes loading {
   to {
      background-position: -200% 0;
   }
}
.empty-state {
   min-height: 180px;
   display: grid;
   place-items: center;
   align-content: center;
   gap: 7px;
   border: 1px dashed #303238;
   border-radius: 12px;
   color: #71747a;
}
.empty-state strong {
   font-size: 0.66rem;
}
.empty-state span {
   font-size: 0.54rem;
}
.workspace-section {
   overflow: hidden;
   margin-bottom: 14px;
   border: 1px solid #292b30;
   border-radius: 12px;
   background: #101114;
}
.system-grid {
   display: grid;
   grid-template-columns: repeat(2, 1fr);
}
.system-grid article {
   min-height: 66px;
   display: grid;
   grid-template-columns: 34px 1fr auto;
   align-items: center;
   gap: 11px;
   padding: 0 15px;
   border-top: 1px solid #27292d;
}
.system-grid article:nth-child(-n + 2) {
   border-top: 0;
}
.system-grid article:nth-child(even) {
   border-left: 1px solid #27292d;
}
.system-grid article > span {
   width: 32px;
   height: 32px;
   display: grid;
   place-items: center;
   border-radius: 8px;
   background: #1d1f23;
   color: #c2c5ca;
}
.system-grid article > div {
   display: grid;
   gap: 3px;
}
.system-grid strong {
   font-size: 0.62rem;
}
.system-grid small {
   color: #73767c;
   font-size: 0.52rem;
}
.system-grid em,
.worker-state,
.fleet-section .section-title > span {
   display: flex;
   align-items: center;
   gap: 5px;
   color: #96999e;
   font-size: 0.53rem;
   font-style: normal;
}
.system-grid em i,
.worker-state i,
.fleet-section .section-title > span i {
   width: 6px;
   height: 6px;
   border-radius: 50%;
   background: #8b8e94;
}
.system-grid em.good i,
.fleet-section .section-title > span.online i,
.worker-state.online i {
   background: #4ac287;
}
.system-grid em.danger i,
.fleet-section .section-title > span.offline i,
.worker-state.offline i {
   background: #da706d;
}
.system-grid em.warning i,
.worker-state.stale i {
   background: #d4a255;
}
.runtime dl {
   display: grid;
   grid-template-columns: repeat(4, 1fr);
   margin: 0;
}
.runtime dl > div {
   display: grid;
   gap: 8px;
   padding: 15px;
   border-left: 1px solid #292b30;
}
.runtime dl > div:first-child {
   border-left: 0;
}
.runtime dt {
   display: flex;
   align-items: center;
   gap: 7px;
   color: #81848a;
   font-size: 0.54rem;
}
.runtime dd {
   margin: 0;
   font-size: 0.82rem;
   font-weight: 720;
}
.worker-command {
   min-height: 64px;
   display: flex;
   align-items: center;
   justify-content: space-between;
   margin-bottom: 14px;
   padding: 0 14px;
   border: 1px solid #2c2e33;
   border-radius: 11px;
   background: #111216;
}
.worker-command > div {
   display: flex;
   align-items: center;
   gap: 11px;
}
.worker-command > div > span {
   width: 34px;
   height: 34px;
   display: grid;
   place-items: center;
   border-radius: 9px;
   background: #202227;
}
.worker-command > div > div {
   display: grid;
   gap: 3px;
}
.worker-command strong {
   font-size: 0.66rem;
}
.worker-command small {
   color: #777a80;
   font-size: 0.53rem;
}
.pool-grid {
   display: grid;
   grid-template-columns: repeat(2, minmax(0, 1fr));
   gap: 10px;
   padding: 12px;
}
.pool-grid > article {
   overflow: hidden;
   border: 1px solid #2c2e33;
   border-radius: 10px;
   background: #0d0e11;
}
.pool-grid header {
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 12px;
}
.pool-grid header > div {
   display: flex;
   align-items: center;
   gap: 9px;
}
.pool-mark {
   width: 31px;
   height: 31px;
   display: grid;
   place-items: center;
   border-radius: 8px;
   background: #202227;
}
.pool-grid header > div > div {
   display: grid;
   gap: 3px;
}
.pool-grid header strong {
   font-size: 0.62rem;
}
.pool-grid header small {
   color: #74777d;
   font-size: 0.5rem;
}
.pool-grid header button {
   height: 30px;
   padding: 0 9px;
   border-color: #393c41;
   background: #191b1f;
   color: #d2d4d7;
}
.endpoint {
   display: grid;
   grid-template-columns: auto minmax(0, 1fr) 28px;
   align-items: center;
   gap: 8px;
   padding: 8px 12px;
   border-block: 1px solid #292b30;
   background: #121317;
}
.endpoint > span {
   color: #72757b;
   font-size: 0.48rem;
}
.endpoint code {
   overflow: hidden;
   color: #a4a8ad;
   font-size: 0.49rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.endpoint button,
.token-grid > div > button,
.delete-worker {
   width: 28px;
   height: 28px;
   display: grid;
   place-items: center;
   border: 1px solid #34363b;
   border-radius: 7px;
   background: #181a1e;
   color: #aeb1b6;
}
.token-grid {
   display: grid;
   padding: 7px;
}
.token-grid > div {
   min-height: 46px;
   display: grid;
   grid-template-columns: 26px 1fr 28px 28px;
   align-items: center;
   gap: 7px;
   padding: 0 6px;
   border-radius: 7px;
}
.token-grid > div:hover {
   background: #17191d;
}
.token-grid > div.disabled {
   opacity: 0.48;
}
.token-grid > div > span {
   color: #96999e;
}
.token-grid > div > div {
   display: grid;
   gap: 3px;
}
.token-grid strong {
   font-size: 0.56rem;
}
.token-grid small {
   color: #6f7278;
   font-size: 0.48rem;
}
.token-empty {
   height: 42px;
   border: 1px dashed #34363b;
   border-radius: 7px;
   background: transparent;
   color: #888b91;
   font-size: 0.53rem;
}
.fleet-grid article {
   min-height: 64px;
   display: grid;
   grid-template-columns:
      34px minmax(170px, 1.1fr) minmax(150px, 0.75fr)
      120px 120px 30px;
   align-items: center;
   gap: 11px;
   padding: 0 14px;
   border-top: 1px solid #292b30;
}
.fleet-grid article:first-child {
   border-top: 0;
}
.worker-avatar {
   width: 32px;
   height: 32px;
   display: grid;
   place-items: center;
   border-radius: 8px;
   background: #1d1f23;
}
.worker-name,
.worker-latency {
   display: grid;
   gap: 3px;
}
.worker-name strong,
.worker-latency strong {
   overflow: hidden;
   font-size: 0.59rem;
   text-overflow: ellipsis;
   white-space: nowrap;
}
.worker-name small,
.worker-latency small,
.worker-load small {
   color: #74777d;
   font-size: 0.49rem;
}
.worker-load {
   display: grid;
   gap: 6px;
}
.worker-load > span {
   height: 4px;
   overflow: hidden;
   border-radius: 2px;
   background: #292c31;
}
.worker-load > span i {
   display: block;
   height: 100%;
   background: #55c58e;
}
.delete-worker:disabled {
   opacity: 0.3;
}
.token-dialog {
   display: grid;
   gap: 9px;
   padding: 15px;
}
.token-dialog label {
   color: #9a9da3;
   font-size: 0.56rem;
}
.token-dialog input,
.token-dialog select {
   height: 38px;
   padding: 0 10px;
   border: 1px solid #383a40;
   border-radius: 8px;
   outline: 0;
   background: #16181c;
   color: #fff;
   font-size: 0.62rem;
}
.token-dialog input:focus,
.token-dialog select:focus {
   border-color: #85888e;
}
.dialog-primary {
   height: 38px;
   display: flex;
   align-items: center;
   justify-content: center;
   gap: 7px;
   margin-top: 5px;
   border: 0;
   border-radius: 8px;
   background: #f1f2f3;
   color: #111216;
   font-size: 0.62rem;
   font-weight: 750;
}
.dialog-primary:disabled {
   opacity: 0.45;
}
.dialog-error {
   margin: 0;
   color: #e58d89;
   font-size: 0.55rem;
}
.revealed-token {
   display: grid;
   grid-template-columns: minmax(0, 1fr) auto;
   gap: 8px;
}
.revealed-token code {
   overflow: auto;
   padding: 11px;
   border: 1px solid #34363b;
   border-radius: 8px;
   background: #111216;
   color: #d8dadd;
   font-size: 0.57rem;
}
.revealed-token button {
   display: flex;
   align-items: center;
   gap: 6px;
   padding: 0 12px;
   border: 1px solid #3b3d42;
   border-radius: 8px;
   background: #1b1d21;
   color: #fff;
}
.token-dialog > p {
   display: flex;
   align-items: center;
   gap: 6px;
   margin: 0;
   color: #777a80;
   font-size: 0.52rem;
}
.rotating {
   min-height: 140px;
   display: grid;
   place-items: center;
   align-content: center;
   gap: 8px;
}
.rotating strong {
   font-size: 0.66rem;
}
.rotating small {
   color: #76797f;
   font-size: 0.52rem;
}
.create-scroll {
   height: min(720px, calc(86dvh - 54px));
}
.create-content {
   min-height: 0;
   padding: 8px;
}
.match-grid,
.pool-grid {
   grid-template-columns: repeat(auto-fit, minmax(min(520px, 100%), 1fr));
}
@media (max-width: 1100px) {
   .match-grid,
   .pool-grid {
      grid-template-columns: 1fr;
   }
   .ops-command {
      grid-template-columns: 1fr;
   }
   .ops-health {
      border-right: 0;
      border-bottom: 1px solid #2b2d31;
   }
   .fleet-grid article {
      grid-template-columns: 34px 1fr 140px 100px 110px 30px;
   }
}
@media (max-width: 760px) {
   .view-panel {
      padding: 14px;
   }
   .page-header {
      padding-inline: 14px;
   }
   .ops-command dl {
      grid-template-columns: repeat(2, 1fr);
   }
   .system-grid {
      grid-template-columns: 1fr;
   }
   .system-grid article:nth-child(n) {
      border-left: 0;
      border-top: 1px solid #27292d;
   }
   .system-grid article:first-child {
      border-top: 0;
   }
   .runtime dl {
      grid-template-columns: repeat(2, 1fr);
   }
   .fleet-grid article {
      grid-template-columns: 34px 1fr auto;
   }
   .worker-load,
   .worker-latency {
      grid-column: 2;
   }
   .worker-state {
      grid-column: 3;
      grid-row: 1;
   }
   .delete-worker {
      grid-column: 3;
   }
   .pool-grid {
      padding: 8px;
   }
   .control-actions label {
      width: 100%;
   }
   .control-actions {
      flex-wrap: wrap;
   }
}
@media (prefers-reduced-motion: reduce) {
   .spinning,
   .match-loading {
      animation: none;
   }
}
.control-page {
   background: #181818;
}
.page-header {
   border-bottom-color: #2b2b2e;
   background: #1b1b1ced;
}
.page-header p,
.page-header__sync span,
.section-title p {
   color: #929296;
}
.page-header__sync button {
   border-color: #3a3a3d;
   background: #242426;
   color: #c3c3c7;
}
.ops-command {
   border: 1px solid #303033;
   border-radius: 12px;
   background: #1d1d1f;
}
.ops-health,
.ops-command dl > div,
.section-title.compact,
.system-grid article,
.runtime dl > div {
   border-color: #303033;
}
.storage-overview {
   border: 1px solid #2c2c2f;
   border-radius: 12px;
   background: #171718;
}
.control-actions {
   background: #181818f2;
}
.control-actions label {
   border-color: #343437;
   background: #222224;
}
.empty-state {
   border: 1px solid #2c2c2f;
   background: #1d1d1f;
}
.workspace-section {
   border: 1px solid #303033;
   border-radius: 12px;
   background: #1c1c1d;
}
.system-grid article > span {
   background: #29292c;
}
.worker-command {
   border-color: #303033;
   background: #1d1d1f;
}
.system-grid article:last-child:nth-child(odd) {
   grid-column: 1/-1;
}
</style>
