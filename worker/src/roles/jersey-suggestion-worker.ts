import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePersonPoseEvidenceChunk,
  PERSON_POSE_KEYPOINT_COUNT,
  PERSON_POSE_STATUS,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, MediaAssetKind, Prisma } from '@volleyball-monitoring/db/client'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'
import {
  appendVerifiedObject,
  createWorkflowMinio,
  readVerifiedObject,
  uploadFile,
  type WorkflowMinio,
} from '../workflow/minio.js'

const LEASE_MS = 15 * 60_000
const RETRY_BASE_MS = 5_000
const POSE_CHUNK_MAX_BYTES = 64n * 1024n * 1024n
const TOP_FRAME_POOL = 40
const SELECTED_FRAME_COUNT = 10
const TILE_WIDTH = 256
const TILE_HEIGHT = 320
const TORSO_POINTS = [5, 6, 11, 12] as const

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

type JerseyFrame = {
  frameIndex: bigint
  quality: number
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

export class JerseySuggestionWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'JerseySuggestionWorkerError'
  }
}

function loadRun(database: PrismaClient, runId: string) {
  return database.reidJerseySuggestionRun.findUnique({
    where: { id: runId },
    include: {
      suggestions: {
        orderBy: { tracklet: { canonicalTrackId: 'asc' } },
        include: { tracklet: true },
      },
      analysisRun: {
        include: {
          aiJob: { include: { clipJob: { include: { clipAsset: true } } } },
          submission: { include: { rally: true } },
          personPoseEvidenceManifests: {
            where: { status: ArtifactState.READY },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              chunks: { orderBy: { chunkIndex: 'asc' }, include: { asset: true } },
            },
          },
        },
      },
    },
  })
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function frameQuality(
  chunk: ReturnType<typeof parsePersonPoseEvidenceChunk>,
  observationIndex: number,
) {
  const bbox = {
    x1: clamp(chunk.bboxX1[observationIndex]!),
    y1: clamp(chunk.bboxY1[observationIndex]!),
    x2: clamp(chunk.bboxX2[observationIndex]!),
    y2: clamp(chunk.bboxY2[observationIndex]!),
  }
  const width = bbox.x2 - bbox.x1
  const height = bbox.y2 - bbox.y1
  if (width <= 0.02 || height <= 0.08) return null
  const confidence = TORSO_POINTS.map(
    point => chunk.keypointConfidence[observationIndex * PERSON_POSE_KEYPOINT_COUNT + point] ?? 0,
  )
  const visible = confidence.filter(value => value >= 0.25).length
  if (visible < 3 || confidence[0]! < 0.2 || confidence[1]! < 0.2) return null
  const torsoConfidence = confidence.reduce((sum, value) => sum + value, 0) / confidence.length
  const area = width * height
  const quality = torsoConfidence * 0.75 + Math.min(1, area / 0.12) * 0.25
  const paddingX = width * 0.16
  const paddingY = height * 0.12
  return {
    quality,
    bbox: {
      x1: clamp(bbox.x1 - paddingX),
      y1: clamp(bbox.y1 - paddingY),
      x2: clamp(bbox.x2 + paddingX),
      y2: clamp(bbox.y2 + paddingY),
    },
  }
}

async function collectJerseyFrames(run: LoadedRun, storage: WorkflowMinio) {
  const manifest = run.analysisRun.personPoseEvidenceManifests[0]
  if (!manifest)
    throw new JerseySuggestionWorkerError(
      'every-frame pose evidence is unavailable',
      'POSE_EVIDENCE_UNAVAILABLE',
      true,
    )
  const byTrack = new Map<number, JerseyFrame[]>()
  for (const row of manifest.chunks) {
    const bytes = await readVerifiedObject(storage.client, row.asset, POSE_CHUNK_MAX_BYTES)
    const chunk = parsePersonPoseEvidenceChunk(bytes)
    if (
      chunk.analysisRunId !== run.analysisRunId ||
      chunk.poseRecipeNamespace !== manifest.recipeNamespace ||
      chunk.startFrameIndex !== row.startFrameIndex
    )
      throw new JerseySuggestionWorkerError(
        'pose chunk provenance is invalid',
        'POSE_EVIDENCE_INVALID',
        false,
      )
    for (let localFrame = 0; localFrame < chunk.frameCount; localFrame += 1) {
      const start = chunk.frameOffsets[localFrame]!
      const end = chunk.frameOffsets[localFrame + 1]!
      for (let observation = start; observation < end; observation += 1) {
        if (chunk.statuses[observation] !== PERSON_POSE_STATUS.available) continue
        const measured = frameQuality(chunk, observation)
        const trackId = chunk.trackIds[observation]
        if (!measured || trackId === undefined) continue
        const rows = byTrack.get(trackId) ?? []
        rows.push({
          frameIndex: chunk.startFrameIndex + BigInt(localFrame),
          quality: measured.quality,
          bbox: measured.bbox,
        })
        byTrack.set(trackId, rows)
      }
    }
  }
  return byTrack
}

function selectFrames(runId: string, trackletId: string, candidates: JerseyFrame[]) {
  const pool = [...candidates]
    .sort((left, right) => right.quality - left.quality)
    .slice(0, TOP_FRAME_POOL)
  return pool
    .map(frame => ({
      frame,
      randomOrder: createHash('sha256')
        .update(`${runId}:${trackletId}:${frame.frameIndex}`)
        .digest('hex'),
    }))
    .sort((left, right) => left.randomOrder.localeCompare(right.randomOrder))
    .slice(0, SELECTED_FRAME_COUNT)
    .map(row => row.frame)
    .sort((left, right) => Number(left.frameIndex - right.frameIndex))
}

function boundedStderr(chunks: Buffer[]) {
  return Buffer.concat(chunks).toString('utf8').trim().slice(-4_000)
}

async function renderMontage(
  clipPath: string,
  outputPath: string,
  frames: JerseyFrame[],
  signal: AbortSignal,
) {
  const inputs = frames.map((_, index) => `[s${index}]`).join('')
  const split = frames.length > 1 ? `[0:v]split=${frames.length}${inputs};` : ''
  const crops = frames
    .map((frame, index) => {
      const source = frames.length > 1 ? `[s${index}]` : '[0:v]'
      const { x1, y1, x2, y2 } = frame.bbox
      const width = Math.max(0.02, x2 - x1).toFixed(6)
      const height = Math.max(0.02, y2 - y1).toFixed(6)
      return `${source}select='eq(n\\,${frame.frameIndex})',crop='${width}*iw':'${height}*ih':'${x1.toFixed(6)}*iw':'${y1.toFixed(6)}*ih',scale=${TILE_WIDTH}:${TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TILE_WIDTH}:${TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x111827,setpts=PTS-STARTPTS[c${index}]`
    })
    .join(';')
  const columns = Math.min(5, frames.length)
  const layout = frames
    .map(
      (_, index) =>
        `${(index % columns) * TILE_WIDTH}_${Math.floor(index / columns) * TILE_HEIGHT}`,
    )
    .join('|')
  const stackInputs = frames.map((_, index) => `[c${index}]`).join('')
  const stack =
    frames.length === 1
      ? '[c0]null[out]'
      : `${stackInputs}xstack=inputs=${frames.length}:layout=${layout}:fill=0x111827[out]`
  const filter = `${split}${crops};${stack}`
  const child = spawn(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      clipPath,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-y',
      outputPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )
  const stderr: Buffer[] = []
  child.stderr.on('data', chunk => {
    if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 256 * 1024)
      stderr.push(Buffer.from(chunk))
  })
  const abort = () => child.kill('SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => signal.removeEventListener('abort', abort))
  if (signal.aborted)
    throw new JerseySuggestionWorkerError('jersey montage was cancelled', 'CANCELLED', true)
  if (code !== 0)
    throw new JerseySuggestionWorkerError(
      boundedStderr(stderr) || `ffmpeg exited ${code}`,
      'MONTAGE_RENDER_FAILED',
      true,
    )
}

function normalizeJerseyNumber(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = String(value)
    .trim()
    .match(/^#?\s*(\d{1,3})$/)
  return match ? String(Number(match[1])) : null
}

function parseModelJson(content: unknown) {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map(item =>
              item && typeof item === 'object' && 'text' in item ? String(item.text) : '',
            )
            .join('')
        : ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('vision API response did not contain a JSON object')
  const parsed: unknown = JSON.parse(match[0])
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('vision API response JSON must be an object')
  return parsed as Record<string, unknown>
}

async function callVisionApi(
  montageBytes: Buffer,
  candidates: Array<{ id: string; jerseyNumber: string; displayName: string | null }>,
  signal: AbortSignal,
) {
  const apiKey = process.env.JERSEY_VISION_API_KEY?.trim()
  const baseUrl = (process.env.JERSEY_VISION_BASE_URL ?? 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  )
  const model = process.env.JERSEY_VISION_MODEL?.trim() || 'gpt-4.1-mini'
  if (!apiKey)
    throw new JerseySuggestionWorkerError(
      'JERSEY_VISION_API_KEY is not configured',
      'JERSEY_VISION_NOT_CONFIGURED',
      false,
    )
  const rosterText = candidates
    .map(candidate => `#${candidate.jerseyNumber} ${candidate.displayName ?? '(name unavailable)'}`)
    .join('\n')
  const timeoutMs = Math.max(5_000, Number(process.env.JERSEY_VISION_TIMEOUT_MS ?? 120_000))
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: requestSignal,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number(process.env.JERSEY_VISION_MAX_TOKENS ?? 300),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You read volleyball jersey numbers conservatively. Never infer identity from face, body, or roster order. Return unknown when the number is not consistently readable.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `All montage tiles show one Local ID. Choose only a jersey number from this team roster or null. Return JSON: {"jersey_number": string|null, "confidence": number 0..1, "alternatives": [{"jersey_number": string, "confidence": number}], "reason": string}.\nRoster:\n${rosterText}`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${montageBytes.toString('base64')}` },
            },
          ],
        },
      ],
    }),
  })
  const responseText = await response.text()
  if (!response.ok)
    throw new JerseySuggestionWorkerError(
      `vision API ${response.status}: ${responseText.slice(0, 1_000)}`,
      'JERSEY_VISION_API_ERROR',
      response.status === 408 || response.status === 429 || response.status >= 500,
    )
  const payload: unknown = JSON.parse(responseText)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('vision API response must be an object')
  const choices = (payload as { choices?: unknown }).choices
  const first = Array.isArray(choices) ? choices[0] : null
  const message =
    first && typeof first === 'object' ? (first as { message?: unknown }).message : null
  const content =
    message && typeof message === 'object' ? (message as { content?: unknown }).content : null
  const normalized = parseModelJson(content)
  return { model, payload, normalized }
}

async function claimRun(database: PrismaClient) {
  const now = new Date()
  const candidates = await database.reidJerseySuggestionRun.findMany({
    where: {
      OR: [
        { status: JobStatus.QUEUED, availableAt: { lte: now } },
        { status: JobStatus.RUNNING, leasedUntil: { lt: now } },
      ],
    },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
    take: 8,
    select: { id: true },
  })
  for (const candidate of candidates) {
    const claimed = await database.reidJerseySuggestionRun.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { status: JobStatus.QUEUED, availableAt: { lte: now } },
          { status: JobStatus.RUNNING, leasedUntil: { lt: now } },
        ],
      },
      data: {
        status: JobStatus.RUNNING,
        attemptCount: { increment: 1 },
        leasedUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
        errorMessage: null,
      },
    })
    if (claimed.count === 1) return candidate.id
  }
  return null
}

async function retryOrFail(database: PrismaClient, runId: string, error: unknown) {
  const run = await database.reidJerseySuggestionRun.findUnique({
    where: { id: runId },
    select: { attemptCount: true, maxAttempts: true, status: true },
  })
  if (!run || run.status !== JobStatus.RUNNING) return
  const retryable = !(error instanceof JerseySuggestionWorkerError) || error.retryable
  const failed = !retryable || run.attemptCount >= run.maxAttempts
  const message = error instanceof Error ? error.message.slice(0, 1_000) : 'unknown worker error'
  await database.reidJerseySuggestionRun.update({
    where: { id: runId },
    data: failed
      ? {
          status: JobStatus.FAILED,
          leasedUntil: null,
          completedAt: new Date(),
          errorMessage: message,
        }
      : {
          status: JobStatus.QUEUED,
          leasedUntil: null,
          availableAt: new Date(Date.now() + RETRY_BASE_MS * 2 ** (run.attemptCount - 1)),
          errorMessage: message,
        },
  })
}

export async function materializeJerseySuggestionRun(
  database: PrismaClient,
  runId: string,
  storage: WorkflowMinio,
  signal: AbortSignal,
) {
  const run = await loadRun(database, runId)
  if (!run)
    throw new JerseySuggestionWorkerError('jersey suggestion run is missing', 'RUN_MISSING', false)
  if (run.status !== JobStatus.RUNNING)
    throw new JerseySuggestionWorkerError('jersey suggestion run is not leased', 'LEASE_LOST', true)
  if (!process.env.JERSEY_VISION_API_KEY?.trim())
    throw new JerseySuggestionWorkerError(
      'JERSEY_VISION_API_KEY is not configured',
      'JERSEY_VISION_NOT_CONFIGURED',
      false,
    )
  const clipAsset = run.analysisRun.aiJob.clipJob.clipAsset
  if (!clipAsset || clipAsset.state !== ArtifactState.READY)
    throw new JerseySuggestionWorkerError('canonical clip is unavailable', 'CLIP_UNAVAILABLE', true)
  const matchId = run.analysisRun.submission.rally.matchId
  const roster = await database.matchRosterEntry.findMany({
    where: { matchId, active: true },
    orderBy: [{ teamId: 'asc' }, { jerseyNumber: 'asc' }],
  })
  const framesByTrack = await collectJerseyFrames(run, storage)
  const directory = await mkdtemp(join(tmpdir(), 'volleyball-jersey-'))
  try {
    const clipPath = join(directory, 'clip.mp4')
    await appendVerifiedObject(storage.client, clipAsset, clipPath)
    let completed = 0
    let failed = 0
    const model = process.env.JERSEY_VISION_MODEL?.trim() || 'gpt-4.1-mini'
    await database.reidJerseySuggestionRun.update({
      where: { id: run.id },
      data: { modelNamespace: `openai-compatible/${model}` },
    })
    for (const item of run.suggestions) {
      if (signal.aborted) throw new Error('jersey suggestion worker stopped')
      if (item.status === JobStatus.COMPLETED) {
        completed += 1
        continue
      }
      await database.reidJerseySuggestion.update({
        where: { id: item.id },
        data: { status: JobStatus.RUNNING, startedAt: new Date(), errorMessage: null },
      })
      await database.reidJerseySuggestionRun.update({
        where: { id: run.id },
        data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
      })
      try {
        const aliases = new Set(item.tracklet.trackIdAliases)
        const frames = selectFrames(
          run.id,
          item.trackletId,
          [...aliases]
            .flatMap(trackId => framesByTrack.get(trackId) ?? [])
            .filter(
              frame =>
                frame.frameIndex >= item.tracklet.firstFrameIndex &&
                frame.frameIndex <= item.tracklet.lastFrameIndex,
            ),
        )
        if (frames.length === 0)
          throw new JerseySuggestionWorkerError(
            'no frame had a sufficiently visible jersey torso',
            'NO_VISIBLE_JERSEY_FRAME',
            false,
          )
        const montagePath = join(directory, `${item.id}.jpg`)
        await renderMontage(clipPath, montagePath, frames, signal)
        const objectKey = `reid/jersey-montages/${item.id}.jpg`
        const uploaded = await uploadFile(
          storage.client,
          storage.analysisBucket,
          objectKey,
          montagePath,
          'image/jpeg',
          { 'x-amz-meta-artifact-kind': 'JERSEY_MONTAGE' },
        )
        const montageAsset = await database.mediaAsset.upsert({
          where: { bucket_objectKey: { bucket: storage.analysisBucket, objectKey } },
          update: {
            byteLength: uploaded.byteLength,
            sha256: uploaded.sha256,
            state: ArtifactState.READY,
            readyAt: new Date(),
          },
          create: {
            kind: MediaAssetKind.JERSEY_MONTAGE,
            bucket: storage.analysisBucket,
            objectKey,
            contentType: 'image/jpeg',
            byteLength: uploaded.byteLength,
            sha256: uploaded.sha256,
            internalSchemaVersion: '1.0.0',
            state: ArtifactState.READY,
            readyAt: new Date(),
          },
        })
        const teamId =
          item.tracklet.courtSide === 'LEFT'
            ? run.analysisRun.submission.leftTeamId
            : item.tracklet.courtSide === 'RIGHT'
              ? run.analysisRun.submission.rightTeamId
              : null
        const candidates = roster
          .filter(entry => !teamId || entry.teamId === teamId)
          .map(entry => ({
            id: entry.id,
            jerseyNumber: entry.jerseyNumber,
            displayName: entry.displayNameSnapshot,
          }))
        const montageBytes = await readVerifiedObject(
          storage.client,
          montageAsset,
          16n * 1024n * 1024n,
        )
        const vision = await callVisionApi(montageBytes, candidates, signal)
        const jerseyNumber = normalizeJerseyNumber(vision.normalized.jersey_number)
        const confidenceValue = Number(vision.normalized.confidence)
        const confidence = Number.isFinite(confidenceValue)
          ? Math.max(0, Math.min(1, confidenceValue))
          : null
        const matches = jerseyNumber
          ? candidates.filter(
              candidate => normalizeJerseyNumber(candidate.jerseyNumber) === jerseyNumber,
            )
          : []
        const suggestedRosterEntryId = matches.length === 1 ? matches[0]!.id : null
        await database.reidJerseySuggestion.update({
          where: { id: item.id },
          data: {
            status: JobStatus.COMPLETED,
            selectedFrameIndices: frames.map(frame => frame.frameIndex),
            montageAssetId: montageAsset.id,
            suggestedJerseyNumber: jerseyNumber,
            suggestedRosterEntryId,
            confidence,
            alternatives: json(vision.normalized.alternatives ?? []),
            rawResponse: json({ model: vision.model, response: vision.payload }),
            completedAt: new Date(),
            errorMessage:
              jerseyNumber && matches.length !== 1
                ? '辨識到背號，但名單中找不到唯一對應球員'
                : null,
          },
        })
        completed += 1
      } catch (error) {
        failed += 1
        await database.reidJerseySuggestion.update({
          where: { id: item.id },
          data: {
            status: JobStatus.FAILED,
            completedAt: new Date(),
            errorMessage:
              error instanceof Error ? error.message.slice(0, 1_000) : 'unknown item error',
          },
        })
        if (error instanceof JerseySuggestionWorkerError && error.retryable) throw error
      }
    }
    await database.reidJerseySuggestionRun.update({
      where: { id: run.id },
      data: {
        status: completed > 0 ? JobStatus.COMPLETED : JobStatus.FAILED,
        leasedUntil: null,
        completedAt: new Date(),
        errorMessage: failed > 0 ? `${failed} 個 Local ID 無法產生背號建議` : null,
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function createJerseySuggestionWorker(
  database: PrismaClient,
  options: {
    storage?: WorkflowMinio
    onError?: (error: unknown) => void
    disconnectOnStop?: boolean
  } = {},
): PollingLifecycle {
  let storage = options.storage ?? null
  return createPollingLifecycle(
    async signal => {
      const runId = await claimRun(database)
      if (!runId) return false
      try {
        storage ??= createWorkflowMinio()
        await materializeJerseySuggestionRun(database, runId, storage, signal)
      } catch (error) {
        await retryOrFail(database, runId, error)
        options.onError?.(error)
      }
      return true
    },
    {
      idleMs: 750,
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
    },
  )
}
