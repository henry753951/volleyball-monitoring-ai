<script setup lang="ts">
import { LoaderCircle, LogIn } from 'lucide-vue-next'

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
      <div class="login-brand"><span>V</span><small>VOLLYAI</small></div>
      <p class="login-eyebrow">OPERATIONS WORKSPACE</p>
      <h1 id="login-title">登入 VollyAI</h1>
      <p class="login-description">使用主帳號進入標註工作區與控制台。</p>
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
          <LogIn v-else :size="16" />
          {{ pending ? '登入中…' : '登入' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(circle at 50% 0, #20365e 0, #101826 40%, #080b12 100%);
  color: #f7f9fc;
  font-family: 'Segoe UI Variable Text', system-ui, sans-serif;
}
.login-card {
  width: min(100%, 400px);
  padding: 34px;
  border: 1px solid #ffffff1a;
  border-radius: 22px;
  background: #111827e8;
  box-shadow: 0 24px 80px #0008;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #9cbcff;
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.login-brand span {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid #8eb4ff66;
  border-radius: 9px;
  background: #26477c;
  color: white;
  letter-spacing: 0;
}
.login-eyebrow {
  margin: 44px 0 8px;
  color: #7596c8;
  font-size: 0.65rem;
  font-weight: 750;
  letter-spacing: 0.14em;
}
h1 {
  margin: 0;
  font-size: 1.8rem;
  letter-spacing: -0.04em;
}
.login-description {
  margin: 9px 0 28px;
  color: #a9b5ca;
  font-size: 0.86rem;
}
.login-form {
  display: grid;
  gap: 16px;
}
.login-form label {
  display: grid;
  gap: 7px;
  color: #c6d2e5;
  font-size: 0.75rem;
  font-weight: 650;
}
.login-form input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 13px;
  border: 1px solid #ffffff1f;
  border-radius: 10px;
  outline: none;
  background: #0a1020;
  color: #f7f9fc;
  font: inherit;
}
.login-form input:focus {
  border-color: #79a6ff;
  box-shadow: 0 0 0 3px #79a6ff26;
}
.login-form button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
  border: 0;
  border-radius: 10px;
  background: #4c8dff;
  color: white;
  cursor: pointer;
  font: inherit;
  font-weight: 750;
}
.login-form button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.login-error {
  margin: 0;
  color: #ffb4b4;
  font-size: 0.78rem;
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
  .login-card {
    padding: 26px;
  }
}
</style>
