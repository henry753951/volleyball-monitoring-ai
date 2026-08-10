<script setup lang="ts">
import { Boxes, ExternalLink, GitCommitHorizontal, PackageCheck } from 'lucide-vue-next'
import type { DeepReadonly } from 'vue'
import type { DeploymentSnapshot } from '~/lib/operationsMonitor'

defineProps<{ deployment: DeepReadonly<DeploymentSnapshot> | null }>()

function shortSha(value: string | null) {
  return value?.slice(0, 8) ?? '—'
}

function shortDigest(value: string | null) {
  return value ? `${value.slice(0, 15)}…${value.slice(-8)}` : '—'
}

function commitUrl(repositoryUrl: string | null, sha: string | null) {
  return repositoryUrl && sha ? `${repositoryUrl.replace(/\/$/, '')}/commit/${sha}` : null
}

function statusLabel(value: string) {
  if (value === 'ready') return '已就緒'
  if (value === 'progressing') return '更新中'
  if (value === 'degraded') return '異常'
  return '未知'
}
</script>

<template>
  <section class="deployment-surface" aria-labelledby="deployment-title">
    <header>
      <div>
        <h2 id="deployment-title"><Boxes :size="17" />版本與部署</h2>
        <p>Git source、實際 image digest 與 Kubernetes rollout</p>
      </div>
      <span :class="deployment?.overallStatus ?? 'unknown'">
        <i />{{ statusLabel(deployment?.overallStatus ?? 'unknown') }}
      </span>
    </header>
    <div v-if="!deployment?.available" class="deployment-empty">
      <PackageCheck :size="20" />目前 runtime 未提供部署中繼資料
    </div>
    <div v-else class="deployment-list">
      <article v-for="component in deployment.components" :key="component.component">
        <div class="component-heading">
          <strong>{{ component.name }}</strong>
          <span :class="component.status"><i />{{ statusLabel(component.status) }}</span>
        </div>
        <dl>
          <div><dt>版本</dt><dd>{{ component.version ?? '—' }}</dd></div>
          <div>
            <dt><GitCommitHorizontal :size="13" />Git SHA</dt>
            <dd>
              <a v-if="commitUrl(component.repositoryUrl, component.gitSha)" :href="commitUrl(component.repositoryUrl, component.gitSha)!" target="_blank" rel="noreferrer">
                {{ shortSha(component.gitSha) }}<ExternalLink :size="11" />
              </a>
              <template v-else>{{ shortSha(component.gitSha) }}</template>
            </dd>
          </div>
          <div><dt>Image digest</dt><dd><code :title="component.imageDigest ?? ''">{{ shortDigest(component.imageDigest) }}</code></dd></div>
          <div><dt>Rollout</dt><dd>{{ component.readyReplicas }} / {{ component.desiredReplicas }} ready</dd></div>
          <div v-if="component.nodeNames.length"><dt>節點</dt><dd>{{ component.nodeNames.join(', ') }}</dd></div>
          <div v-if="component.accelerator"><dt>GPU</dt><dd>{{ component.accelerator }}</dd></div>
          <div v-if="component.modelVersion"><dt>模型</dt><dd>{{ component.modelVersion }}</dd></div>
        </dl>
      </article>
    </div>
  </section>
</template>

<style scoped>
.deployment-surface{overflow:hidden;border:1px solid #303033;border-radius:14px;background:#1b1b1c}.deployment-surface>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid #2b2b2e}.deployment-surface h2{display:flex;align-items:center;gap:8px;margin:0;color:#f3f4f5;font-size:.7rem}.deployment-surface header p{margin:4px 0 0;color:#85858a;font-size:.54rem}.deployment-surface header>span,.component-heading>span{display:flex;align-items:center;gap:6px;color:#a0a0a5;font-size:.51rem}.deployment-surface i{width:6px;height:6px;border-radius:50%;background:#6f737a}.deployment-surface .ready i{background:#4bc28a}.deployment-surface .progressing i{background:#d4a255}.deployment-surface .degraded i{background:#d56f6d}.deployment-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(265px,1fr))}.deployment-list article{padding:16px 20px;border-right:1px solid #2b2b2e;border-bottom:1px solid #2b2b2e}.component-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.component-heading strong{font-size:.62rem}.deployment-list dl{display:grid;gap:8px;margin:14px 0 0}.deployment-list dl>div{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;gap:8px}.deployment-list dt{display:flex;align-items:center;gap:5px;color:#7f7f84;font-size:.49rem}.deployment-list dd{overflow:hidden;margin:0;color:#c8c9cc;font-size:.52rem;text-overflow:ellipsis;white-space:nowrap}.deployment-list a{display:inline-flex;align-items:center;gap:4px;color:#9fc5ff;text-decoration:none}.deployment-list code{font-size:.48rem}.deployment-empty{min-height:100px;display:flex;align-items:center;justify-content:center;gap:8px;color:#7f7f84;font-size:.55rem}@media(max-width:700px){.deployment-list{grid-template-columns:1fr}}
</style>
