<script setup lang="ts">
import { LoaderCircle, RefreshCw, ExternalLink } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { onMounted } from 'vue'
import UiButton from '~/components/ui/Button.vue'
import { createMediaSourceClient, type YoutubeAuthStatus } from '~/lib/mediaSourceClient'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const mediaSources = createMediaSourceClient()
const status = ref<YoutubeAuthStatus | null>(null)
const pending = ref(false)
const error = ref<string | null>(null)

const browserLabel = computed(() => {
  if (status.value?.browser === 'running') return '執行中'
  if (status.value?.browser === 'offline') return '離線'
  return '未知'
})
const sessionLabel = computed(() => {
  if (status.value?.sessionState === 'available') return 'Cookie 可用'
  if (status.value?.sessionState === 'login_required') return '需要登入'
  return '尚未檢查'
})

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-TW') : '—'
}

async function load(refresh = false) {
  pending.value = true
  error.value = null
  try {
    status.value = refresh
      ? await mediaSources.refreshYoutubeAuth()
      : await mediaSources.youtubeAuthStatus()
    if (refresh && status.value.cookieAvailable) toast.success('YouTube Cookie 可用')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法取得 YouTube 登入狀態'
  } finally {
    pending.value = false
  }
}

function openBrowser() {
  window.open('/youtube-browser/', '_blank', 'noopener,noreferrer')
}

onMounted(() => void load())
</script>

<template>
  <section class="youtube-auth-card" :class="{ compact }" aria-labelledby="youtube-auth-title">
    <div class="youtube-auth-card__heading">
      <div>
        <span class="eyebrow">YouTube 帳號</span>
        <h2 id="youtube-auth-title">Browser session</h2>
      </div>
      <span class="status-pill" :class="{ success: status?.cookieAvailable }">{{
        sessionLabel
      }}</span>
    </div>
    <div class="youtube-auth-card__grid">
      <span>Browser</span><strong>{{ browserLabel }}</strong> <span>Cookie revision</span
      ><strong>{{ status?.revision ?? '—' }}</strong> <span>Profile updated</span
      ><strong>{{ formatDate(status?.profileUpdatedAt) }}</strong> <span>Last read</span
      ><strong>{{ formatDate(status?.lastReadAt) }}</strong>
    </div>
    <p v-if="error || status?.lastError" class="youtube-auth-card__error">
      {{ error || status?.lastError }}
    </p>
    <div class="youtube-auth-card__actions">
      <UiButton variant="ghost" size="sm" :disabled="pending" @click="void load(true)">
        <LoaderCircle v-if="pending" class="spin" :size="14" /><RefreshCw v-else :size="14" />
        重新檢查 Cookie
      </UiButton>
      <UiButton variant="secondary" size="sm" @click="openBrowser">
        <ExternalLink :size="14" /> 開啟登入瀏覽器
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.youtube-auth-card {
  border: 1px solid rgb(231 229 228);
  border-radius: 1rem;
  background: white;
  padding: 1.25rem;
  box-shadow: 0 2px 10px rgb(28 25 23 / 0.04);
}
.youtube-auth-card__heading,
.youtube-auth-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.youtube-auth-card__heading h2 {
  margin-top: 0.25rem;
  font-size: 1.05rem;
  font-weight: 700;
}
.eyebrow {
  color: rgb(120 113 108);
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.status-pill {
  border-radius: 999px;
  background: rgb(245 245 244);
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  color: rgb(87 83 78);
}
.status-pill.success {
  background: rgb(220 252 231);
  color: rgb(22 101 52);
}
.youtube-auth-card__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.55rem 0.9rem;
  margin-top: 1rem;
  font-size: 0.8rem;
}
.youtube-auth-card__grid span {
  color: rgb(120 113 108);
}
.youtube-auth-card__grid strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.youtube-auth-card__error {
  margin-top: 0.75rem;
  color: rgb(185 28 28);
  font-size: 0.8rem;
}
.youtube-auth-card__actions {
  justify-content: flex-start;
  flex-wrap: wrap;
  margin-top: 1rem;
}
.compact {
  box-shadow: none;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
