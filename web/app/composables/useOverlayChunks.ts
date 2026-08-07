import { parseBrowserOverlayChunk, type BrowserOverlayChunk } from '@volleyball-monitoring/contracts'
import type { MaybeRefOrGetter } from 'vue'

interface OverlayManifestChunk {
  chunk_index: number
  start_frame_index: string
  frame_count: number
  url: string
  byte_length: string
  sha256: string
}

export interface OverlayManifest {
  schema_version: '1.0.0'
  analysis_id: string
  overlay_version: string
  video: { width: number; height: number; fps: { num: number; den: number }; total_frames: string }
  chunk_frame_count: number
  chunks: OverlayManifestChunk[]
  action_taxonomy: { id?: string; version?: string; labels?: string[] } | null
}

function parseManifest(value: unknown): OverlayManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Overlay manifest is not an object')
  const input = value as Record<string, unknown>
  const video = input.video as Record<string, unknown> | undefined
  const fps = video?.fps as Record<string, unknown> | undefined
  const chunks = input.chunks
  if (input.schema_version !== '1.0.0' || typeof input.analysis_id !== 'string' || typeof input.overlay_version !== 'string' || !video || !Number.isInteger(video.width) || !Number.isInteger(video.height) || !fps || !Number.isInteger(fps.num) || !Number.isInteger(fps.den) || typeof video.total_frames !== 'string' || !/^\d+$/.test(video.total_frames) || !Number.isSafeInteger(input.chunk_frame_count) || Number(input.chunk_frame_count) < 1 || !Array.isArray(chunks)) throw new TypeError('Overlay manifest failed schema validation')
  for (const item of chunks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Overlay manifest chunk is invalid')
    const chunk = item as Record<string, unknown>
    if (!Number.isSafeInteger(chunk.chunk_index) || Number(chunk.chunk_index) < 0 || typeof chunk.start_frame_index !== 'string' || !/^\d+$/.test(chunk.start_frame_index) || !Number.isSafeInteger(chunk.frame_count) || Number(chunk.frame_count) < 1 || typeof chunk.url !== 'string' || typeof chunk.byte_length !== 'string' || !/^\d+$/.test(chunk.byte_length) || typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(chunk.sha256)) throw new TypeError('Overlay manifest chunk failed schema validation')
  }
  return value as OverlayManifest
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

export function useOverlayChunks(analysisRunId: MaybeRefOrGetter<string | null>, frame: MaybeRefOrGetter<number>) {
  const manifest = shallowRef<OverlayManifest | null>(null)
  const chunks = shallowRef(new Map<number, BrowserOverlayChunk>())
  const pending = ref(false)
  const error = shallowRef<Error | null>(null)
  const controllers = new Map<number, AbortController>()
  let manifestController: AbortController | null = null
  let generation = 0

  function abortAll() {
    manifestController?.abort()
    manifestController = null
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
  }

  watch(() => toValue(analysisRunId), async (id) => {
    generation += 1
    const currentGeneration = generation
    abortAll()
    manifest.value = null
    chunks.value = new Map()
    error.value = null
    if (!id) return
    pending.value = true
    const controller = new AbortController()
    manifestController = controller
    try {
      const response = await fetch(`/api/v1/analysis-runs/${encodeURIComponent(id)}/overlay-manifest`, { credentials: 'include', signal: controller.signal })
      if (!response.ok) throw new Error(`Overlay manifest returned ${response.status}`)
      const next = parseManifest(await response.json())
      if (currentGeneration === generation) manifest.value = next
    }
    catch (cause) {
      if (!controller.signal.aborted && currentGeneration === generation) error.value = cause instanceof Error ? cause : new Error('Overlay manifest failed')
    }
    finally { if (currentGeneration === generation) pending.value = false }
  }, { immediate: true })

  async function loadChunk(meta: OverlayManifestChunk, currentGeneration: number) {
    if (chunks.value.has(meta.chunk_index) || controllers.has(meta.chunk_index)) return
    const controller = new AbortController()
    controllers.set(meta.chunk_index, controller)
    try {
      const url = new URL(meta.url, window.location.origin)
      if (url.origin !== window.location.origin) throw new Error('Overlay chunk URL must be same-origin')
      const response = await fetch(url, { credentials: 'include', signal: controller.signal })
      if (!response.ok) throw new Error(`Overlay chunk returned ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (BigInt(bytes.byteLength) !== BigInt(meta.byte_length) || await sha256(bytes) !== meta.sha256.toLowerCase()) throw new Error('Overlay chunk checksum or byte length mismatch')
      const parsed = parseBrowserOverlayChunk(bytes)
      if (parsed.chunkIndex !== meta.chunk_index || parsed.startFrameIndex.toString() !== meta.start_frame_index || parsed.frameCount !== meta.frame_count || parsed.analysisId !== manifest.value?.analysis_id || parsed.overlayVersion !== manifest.value?.overlay_version) throw new Error('Overlay chunk metadata mismatch')
      if (currentGeneration === generation) chunks.value = new Map(chunks.value).set(meta.chunk_index, parsed)
    }
    catch (cause) {
      if (!controller.signal.aborted && currentGeneration === generation) error.value = cause instanceof Error ? cause : new Error('Overlay chunk failed')
    }
    finally { controllers.delete(meta.chunk_index) }
  }

  watch([manifest, () => toValue(frame)], ([currentManifest, currentFrame]) => {
    if (!currentManifest || !Number.isSafeInteger(currentFrame) || currentFrame < 0) return
    const targetIndex = Math.floor(currentFrame / currentManifest.chunk_frame_count)
    const wanted = new Set([targetIndex, targetIndex + 1])
    for (const [index, controller] of controllers) if (!wanted.has(index)) { controller.abort(); controllers.delete(index) }
    chunks.value = new Map([...chunks.value].filter(([index]) => wanted.has(index)))
    const currentGeneration = generation
    for (const index of wanted) {
      const meta = currentManifest.chunks.find(chunk => chunk.chunk_index === index)
      if (meta) void loadChunk(meta, currentGeneration)
    }
  }, { immediate: true })

  const currentChunk = computed(() => {
    const currentFrame = toValue(frame)
    for (const chunk of chunks.value.values()) {
      const start = Number(chunk.startFrameIndex)
      if (currentFrame >= start && currentFrame < start + chunk.frameCount) return chunk
    }
    return null
  })

  onBeforeUnmount(abortAll)
  return { actionLabels: computed(() => manifest.value?.action_taxonomy?.labels ?? []), currentChunk, error: readonly(error), manifest: readonly(manifest), pending: readonly(pending) }
}
