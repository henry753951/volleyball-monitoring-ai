<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next'

const route = useRoute()
const viewerState = useViewerState()
const username = ref('')
const password = ref('')
const pending = ref(false)
const error = ref<string | null>(null)

const redirectTarget = computed(() => {
  const value = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
})

onMounted(async () => {
  if (route.query.logged_out === '1') return
  if (await viewerState.refresh()) await navigateTo(redirectTarget.value)
})

async function submit() {
  if (pending.value || !username.value.trim() || !password.value) return
  pending.value = true
  error.value = null
  try {
    const response = await $fetch('/api/v1/auth/login', {
      body: { password: password.value, username: username.value.trim() },
      credentials: 'include',
      method: 'POST',
    })
    if (!response) throw new Error('登入失敗')
    await viewerState.refresh()
    await navigateTo(redirectTarget.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '帳號或密碼錯誤'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-brand">VollyAI</div>
      <div class="login-heading">
        <h1 id="login-title">登入</h1>
        <p class="login-description">使用主帳號進入工作區。</p>
      </div>
      <form class="login-form" @submit.prevent="submit">
        <label>
          <span>帳號</span>
          <input v-model="username" autocomplete="username" autofocus required type="text" />
        </label>
        <label>
          <span>密碼</span>
          <input v-model="password" autocomplete="current-password" required type="password" />
        </label>
        <p v-if="error" class="login-error" role="alert">{{ error }}</p>
        <button :disabled="pending" type="submit">
          <LoaderCircle v-if="pending" class="spin" :size="16" />
          {{ pending ? '登入中…' : '登入' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100%;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  padding: 32px 20px;
  background: #fff;
}
.login-card {
  width: min(100%, 360px);
}
.login-brand {
  margin-bottom: 64px;
  color: #17191c;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.login-heading {
  margin-bottom: 32px;
}
h1 {
  margin: 0;
  color: #17191c;
  font-size: 1.75rem;
  letter-spacing: -0.03em;
}
.login-description {
  margin: 8px 0 0;
  color: #68707c;
  font-size: 0.9rem;
}
.login-form {
  display: grid;
  gap: 18px;
}
.login-form label {
  display: grid;
  gap: 8px;
  color: #30343a;
  font-size: 0.82rem;
  font-weight: 600;
}
.login-form input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid #d4d8de;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #17191c;
  font: inherit;
}
.login-form input:focus {
  border-color: #1769e0;
  box-shadow: 0 0 0 3px #1769e01f;
}
.login-form button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  border: 0;
  border-radius: 6px;
  background: #1769e0;
  color: white;
  cursor: pointer;
  font: inherit;
  font-weight: 650;
}
.login-form button:hover:not(:disabled) {
  background: #0f59c6;
}
.login-form button:focus-visible {
  outline: 2px solid #1769e0;
  outline-offset: 3px;
}
.login-form button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.login-error {
  margin: 0;
  color: #b42318;
  font-size: 0.82rem;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 520px) {
  .login-brand {
    margin-bottom: 48px;
  }
}
</style>
