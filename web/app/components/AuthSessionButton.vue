<script setup lang="ts">
const viewerState = useViewerState()
const pending = ref(false)

async function logout() {
  if (pending.value) return
  pending.value = true
  try {
    await $fetch('/api/v1/auth/logout', { credentials: 'include', method: 'POST' })
  } finally {
    viewerState.clear()
    pending.value = false
    // Do not carry the protected page into the login screen. If a browser
    // still has a legacy cookie, login's session probe would otherwise send
    // the user straight back to the page they just tried to leave.
    await navigateTo({ path: '/login', query: { logged_out: '1' } })
  }
}
</script>

<template>
  <button v-if="viewerState.viewer.value" class="auth-session-button" type="button" @click="logout">
    <span>{{ pending ? '登出中…' : 'volley-ai' }}</span>
    <small>登出</small>
  </button>
</template>

<style scoped>
.auth-session-button {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid #ffffff24;
  border-radius: 8px;
  background: #ffffff0d;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.69rem;
}
.auth-session-button small {
  color: #9ca9be;
  font-size: 0.62rem;
}
.auth-session-button:active {
  transform: scale(0.98);
}
</style>
