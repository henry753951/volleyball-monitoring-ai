import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PrismaPg } from '@prisma/adapter-pg'
import { Client } from 'minio'
import { PrismaClient } from '../packages/db/generated/client/client.js'
import { FinalizedFileArtifactSource } from '../worker/src/media/fmp4-artifact-source.js'
import { runFfprobe } from '../worker/src/media/ffprobe.js'
import { ingestEnvelope } from '../worker/src/media/ingest-handler.js'
import {
  createEnvelope,
  MEDIA_INGEST_QUEUE,
  sourceOrderFromCandidate,
} from '../worker/src/media/indexer-runtime.js'
import { createMinioMediaObjectStore } from '../worker/src/media/minio-object-store.js'
import { PrismaIngestRepository } from '../worker/src/media/prisma-ingest-repository.js'
import { resolveProgramProfile } from '../worker/src/media/resolvers.js'

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  device: '00000000-0000-4000-8000-000000000002',
  match: '00000000-0000-4000-8000-000000000010',
  leftTeam: '00000000-0000-4000-8000-000000000011',
  rightTeam: '00000000-0000-4000-8000-000000000012',
  leftPlayer: '00000000-0000-4000-8000-000000000021',
  rightPlayer: '00000000-0000-4000-8000-000000000022',
  leftRoster: '00000000-0000-4000-8000-000000000041',
  rightRoster: '00000000-0000-4000-8000-000000000042',
  set: '00000000-0000-4000-8000-000000000030',
  assignment: '00000000-0000-4000-8000-000000000031',
  capture: '00000000-0000-4000-8000-000000000060',
  rally: '421ef85d-688a-4d58-8682-1dd8e8aa7faa',
  submission: 'ae4c3d05-e9de-4529-84b0-e2c41af27b4b',
  clipAsset: 'e906a919-8dbd-4496-bc13-523d3316c607',
  timingAsset: '00000000-0000-4000-8000-000000000070',
  clipJob: '00000000-0000-4000-8000-000000000071',
  ledger: '00000000-0000-4000-8000-000000000072',
  award: '00000000-0000-4000-8000-000000000073',
  aiJob: 'db8bcb88-c287-427b-b4f1-4f6f2d1ae4d8',
} as const

const clipSha256 = 'c1b643c6bcdb0e2bc4a03e349826e2da2463f7267b4e3856977a6bc55617207c'
const sourceSha256 = '6f9d34cb99ddf40466016e7c7c116c1f599f37ebd5e2c5e16bbdffc22391bade'
const clipStartUs = 1_026_163_257n
const clipEndUs = 1_043_370_599n
const sourceDurationUs = 1_800_000_000n
const ingestPath = 'demo/contract-lab'

const sleep = (milliseconds: number) =>
  new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const roundRatio = (value: bigint, denominator: bigint) => (value + denominator / 2n) / denominator

function localDatabaseUrl() {
  const configured =
    process.env.DEMO_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
  return configured.replace('@postgres:5432/', '@127.0.0.1:5433/')
}

function contractLabRoot() {
  return resolve(process.env.CONTRACT_LAB_ROOT ?? '../volleyball-ai-contract-lab')
}

async function fileSha256(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

function createMinio() {
  const endpoint = new URL(
    process.env.DEMO_MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_HOST_PORT ?? '9000'}`,
  )
  return new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || 80),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'volleyball',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'volleyball-dev-secret',
    pathStyle: true,
  })
}

async function uploadFile(
  client: Client,
  bucket: string,
  objectKey: string,
  path: string,
  contentType: string,
) {
  const info = await stat(path)
  const digest = await fileSha256(path)
  await client.putObject(bucket, objectKey, createReadStream(path), info.size, {
    'Content-Type': contentType,
    'x-amz-meta-sha256': digest,
    'x-amz-meta-byte-length': String(info.size),
  })
  return { byteLength: BigInt(info.size), sha256: digest }
}

async function uploadBytes(
  client: Client,
  bucket: string,
  objectKey: string,
  bytes: Buffer,
  contentType: string,
) {
  const digest = sha256(bytes)
  await client.putObject(bucket, objectKey, bytes, bytes.byteLength, {
    'Content-Type': contentType,
    'x-amz-meta-sha256': digest,
    'x-amz-meta-byte-length': String(bytes.byteLength),
  })
  return { byteLength: BigInt(bytes.byteLength), sha256: digest }
}

async function upsertScaffold(db: PrismaClient) {
  await db.$transaction(async tx => {
    await tx.user.upsert({
      where: { email: 'dev.operator@volleyball.local' },
      update: { displayName: 'Demo Operator' },
      create: {
        id: ids.user,
        email: 'dev.operator@volleyball.local',
        displayName: 'Demo Operator',
      },
    })
    await tx.deviceSession.upsert({
      where: { id: ids.device },
      update: { revokedAt: null, lastSeenAt: new Date() },
      create: {
        id: ids.device,
        userId: ids.user,
        label: 'Contract Lab demo importer',
        userAgent: 'bootstrap_contract_lab_demo.ts',
      },
    })
    await tx.team.upsert({
      where: { id: ids.leftTeam },
      update: { name: 'Japan U16', shortName: 'JPN' },
      create: { id: ids.leftTeam, name: 'Japan U16', shortName: 'JPN' },
    })
    await tx.team.upsert({
      where: { id: ids.rightTeam },
      update: { name: 'India U16', shortName: 'IND' },
      create: { id: ids.rightTeam, name: 'India U16', shortName: 'IND' },
    })
    await tx.match.upsert({
      where: { id: ids.match },
      update: { title: 'DEMO · Japan U16 vs India U16', venue: 'Nakhon Pathom', status: 'LIVE' },
      create: {
        id: ids.match,
        title: 'DEMO · Japan U16 vs India U16',
        venue: 'Nakhon Pathom',
        status: 'LIVE',
      },
    })
    await tx.matchTeam.upsert({
      where: { matchId_teamId: { matchId: ids.match, teamId: ids.leftTeam } },
      update: {},
      create: { matchId: ids.match, teamId: ids.leftTeam },
    })
    await tx.matchTeam.upsert({
      where: { matchId_teamId: { matchId: ids.match, teamId: ids.rightTeam } },
      update: {},
      create: { matchId: ids.match, teamId: ids.rightTeam },
    })
    await tx.matchMember.upsert({
      where: { matchId_userId: { matchId: ids.match, userId: ids.user } },
      update: { role: 'OPERATOR' },
      create: { matchId: ids.match, userId: ids.user, role: 'OPERATOR' },
    })
    await tx.matchSet.upsert({
      where: { id: ids.set },
      update: { status: 'LIVE', leftScore: 0, rightScore: 1, scoreRevision: 1 },
      create: {
        id: ids.set,
        matchId: ids.match,
        setNumber: 1,
        status: 'LIVE',
        leftScore: 0,
        rightScore: 1,
        scoreRevision: 1,
      },
    })
    await tx.courtSideAssignment.upsert({
      where: { id: ids.assignment },
      update: { leftTeamId: ids.leftTeam, rightTeamId: ids.rightTeam },
      create: {
        id: ids.assignment,
        setId: ids.set,
        effectiveFromRallyOrdinal: 1,
        leftTeamId: ids.leftTeam,
        rightTeamId: ids.rightTeam,
      },
    })
    for (const [teamIndex, team] of [
      [1, { id: ids.leftTeam, name: 'Japan' }],
      [2, { id: ids.rightTeam, name: 'India' }],
    ] as const) {
      for (let jersey = 1; jersey <= 7; jersey += 1) {
        const playerId =
          jersey === 1
            ? teamIndex === 1
              ? ids.leftPlayer
              : ids.rightPlayer
            : `00000000-0000-4000-8${teamIndex}00-${String(jersey).padStart(12, '0')}`
        const rosterId =
          jersey === 1
            ? teamIndex === 1
              ? ids.leftRoster
              : ids.rightRoster
            : `00000000-0000-4000-9${teamIndex}00-${String(jersey).padStart(12, '0')}`
        const name = `${team.name} #${jersey}`
        await tx.player.upsert({
          where: { id: playerId },
          update: { name, teamId: team.id },
          create: { id: playerId, teamId: team.id, name },
        })
        await tx.matchRosterEntry.upsert({
          where: { id: rosterId },
          update: { active: true, jerseyNumber: String(jersey), displayNameSnapshot: name },
          create: {
            id: rosterId,
            matchId: ids.match,
            teamId: team.id,
            playerId,
            jerseyNumber: String(jersey),
            displayNameSnapshot: name,
          },
        })
      }
    }
    await tx.captureSession.upsert({
      where: { id: ids.capture },
      update: { sourceKind: 'LOCAL_MP4', sourceLabel: 'DEMO 影片' },
      create: {
        id: ids.capture,
        matchId: ids.match,
        sourceKind: 'LOCAL_MP4',
        sourceLabel: 'DEMO 影片',
        ingestPath,
      },
    })
  })
}

function run(command: string, args: string[], cwd?: string) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  })
  return new Promise<void>((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('exit', code =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited ${code}`)),
    )
  })
}

function recorderTimestamp(index: number) {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 2_000)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}_${hour}-${minute}-${second}-000000.mp4`
}

async function prepareOfflineDvr(sourcePath: string) {
  const output = resolve(
    process.env.CONTRACT_LAB_DVR_SPOOL_PATH?.trim() ||
      (process.env.DEV_DATA_ROOT?.trim()
        ? resolve(process.env.DEV_DATA_ROOT, 'contract-lab-dvr')
        : '.data/contract-lab-dvr'),
  )
  await mkdir(output, { recursive: true })
  const manifestPath = resolve(output, '.contract-lab-dvr-v2.json')
  const ready = (await readdir(output)).filter(name =>
    /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}\.mp4$/.test(name),
  )
  const manifest = await readFile(manifestPath, 'utf8').catch(() => null)
  if (ready.length > 0 && manifest !== null) return output
  if (ready.length > 0)
    throw new Error(
      `DVR spool ${output} contains an obsolete or unmanaged build; remove that generated directory before retrying`,
    )
  const building = resolve(output, '.building')
  await rm(building, { recursive: true, force: true })
  await mkdir(building, { recursive: true })
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_segment_type',
      'fmp4',
      '-hls_time',
      '2',
      '-hls_flags',
      'independent_segments',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_segment_filename',
      'segment-%06d.m4s',
      'playlist.m3u8',
    ],
    building,
  )
  const segments = (await readdir(building))
    .filter(name => /^segment-\d{6}\.m4s$/.test(name))
    .sort()
  if (segments.length < 100) throw new Error('offline DVR segmentation produced too few fragments')
  const init = await readFile(resolve(building, 'init.mp4'))
  for (const [index, name] of segments.entries()) {
    const media = await readFile(resolve(building, name))
    await writeFile(resolve(output, recorderTimestamp(index)), Buffer.concat([init, media]))
  }
  await rm(building, { recursive: true, force: true })
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 2, sourceSha256, segmentCount: segments.length })}\n`,
  )
  return output
}

async function ingestOfflineDvr(db: PrismaClient, spoolRoot: string) {
  const files = (await readdir(spoolRoot))
    .filter(name => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}\.mp4$/.test(name))
    .sort()
  if (files.length < 100) throw new Error('offline DVR spool is incomplete')
  const readyCount = await db.dvrSegment.count({
    where: { program: { captureSessionId: ids.capture }, readyAt: { not: null } },
  })
  if (readyCount > files.length)
    throw new Error('persisted DVR contains more fragments than the canonical source')
  const pending = files.slice(readyCount)
  if (readyCount > 0)
    console.log(`DVR import resuming with ${pending.length}/${files.length} fragments remaining`)
  const endpointUrl =
    process.env.DEMO_MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_HOST_PORT ?? '9000'}`
  const repository = new PrismaIngestRepository(db as never)
  const store = createMinioMediaObjectStore({
    endpointUrl,
    useTls: new URL(endpointUrl).protocol === 'https:',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'volleyball',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'volleyball-dev-secret',
    bucket: process.env.MINIO_DVR_BUCKET ?? 'dvr-media',
    operationTimeoutMs: 30_000,
  })
  const source = new FinalizedFileArtifactSource({
    maxInputBytes: 8_000_000_000n,
    maxInitBytes: 64_000_000n,
    maxMediaBytes: 8_000_000_000n,
    readTimeoutMs: 30_000,
  })
  const probe = async (path: string, options: Parameters<typeof runFfprobe>[1]) => {
    const result = await runFfprobe(path, options)
    const frames = result.frames.map(frame => ({ ...frame }))
    const videoIndices = frames.flatMap((frame, index) =>
      frame.media_type === 'video' ? [index] : [],
    )
    const lastIndex = videoIndices.at(-1)
    const previousIndex = videoIndices.at(-2)
    if (
      lastIndex !== undefined &&
      previousIndex !== undefined &&
      frames[lastIndex]!.pkt_duration === undefined
    ) {
      const duration = BigInt(frames[lastIndex]!.pts!) - BigInt(frames[previousIndex]!.pts!)
      if (duration <= 0n) throw new Error('offline DVR terminal frame duration is not inferable')
      frames[lastIndex]!.pkt_duration = duration.toString()
    }
    return { ...result, frames }
  }
  for (const [index, candidate] of pending.entries()) {
    await ingestEnvelope(
      createEnvelope({
        schemaVersion: '1.0.0',
        jobType: MEDIA_INGEST_QUEUE,
        captureSessionId: ids.capture,
        candidate,
        sourceOrder: sourceOrderFromCandidate(candidate),
        sourceRestart: false,
        timestampDiscontinuity: false,
        explicitGapBeforeUs: null,
      }),
      {
        spoolRoot,
        bucket: process.env.MINIO_DVR_BUCKET ?? 'dvr-media',
        repository,
        store,
        source,
        probe,
        profile: (captureSessionId, observed) =>
          resolveProgramProfile(db as never, captureSessionId, observed),
      },
    )
    if ((index + 1) % 25 === 0 || index === pending.length - 1)
      console.log(`DVR import ${files.length - pending.length + index + 1}/${files.length}`)
  }
}

async function waitForTimeline(db: PrismaClient, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const segment = await db.dvrSegment.findFirst({
      where: { program: { captureSessionId: ids.capture }, readyAt: { not: null } },
      orderBy: { sequenceNumber: 'asc' },
      include: { program: true, captureEpoch: true },
    })
    if (segment) return segment
    await sleep(1_000)
  }
  throw new Error('DVR did not publish its first authoritative segment in time')
}

async function createRallyBundle(
  db: PrismaClient,
  client: Client,
  timeline: Awaited<ReturnType<typeof waitForTimeline>>,
  root: string,
) {
  const input = JSON.parse(
    await readFile(resolve(root, 'ai-team-handoff/input/ai-job.json'), 'utf8'),
  ) as any
  const snapshot = JSON.parse(
    await readFile(
      resolve(root, '.data/exports/8469a80e-c0f5-4a57-8859-c8371de7c755/annotation-snapshot.json'),
      'utf8',
    ),
  ) as any
  const clipPath = resolve(root, 'ai-team-handoff/input/clip.mp4')
  const rallyBucket = process.env.MINIO_RALLY_BUCKET ?? 'rally-media'
  const clipObjectKey = `clips/${ids.submission}/${ids.clipJob}.mp4`
  const timingObjectKey = `clips/${ids.submission}/${ids.clipJob}.timing.json`
  const clipUpload = await uploadFile(client, rallyBucket, clipObjectKey, clipPath, 'video/mp4')
  if (clipUpload.sha256 !== clipSha256 || clipUpload.byteLength !== 6_100_084n)
    throw new Error('Contract Lab canonical clip identity changed')

  const timingDocument = {
    schema_version: '1.0.0',
    clip_job_id: ids.clipJob,
    submission_id: ids.submission,
    requested_start_capture_us: clipStartUs.toString(),
    requested_end_capture_us: clipEndUs.toString(),
    actual_start_capture_us: clipStartUs.toString(),
    actual_end_capture_us: clipEndUs.toString(),
    video: input.clip.video,
    key_points: input.key_points,
  }
  const timingBytes = Buffer.from(`${stableJson(timingDocument)}\n`)
  const timingUpload = await uploadBytes(
    client,
    rallyBucket,
    timingObjectKey,
    timingBytes,
    'application/json',
  )

  const epoch = timeline.captureEpoch
  const program = timeline.program
  const sourcePts = (captureTimeUs: bigint) =>
    epoch.sourcePtsOrigin +
    roundRatio(
      (captureTimeUs - epoch.captureTimeOriginUs) * BigInt(epoch.sourceTimeBaseDen),
      1_000_000n * BigInt(epoch.sourceTimeBaseNum),
    )
  const captureFrame = (captureTimeUs: bigint) =>
    epoch.captureFrameOrigin +
    roundRatio(
      (captureTimeUs - epoch.captureTimeOriginUs) * BigInt(program.fpsNum),
      1_000_000n * BigInt(program.fpsDen),
    )
  const points = input.key_points.map((point: any, index: number) => {
    const captureTimeUs = BigInt(snapshot.key_points[index].observed_player_time_us)
    return {
      point,
      captureTimeUs,
      sourcePts: sourcePts(captureTimeUs),
      captureFrameIndex: captureFrame(captureTimeUs),
    }
  })
  const contentHash = sha256(
    stableJson({
      source: 'contract-lab-demo-v1',
      key_points: input.key_points,
      outcome: input.outcome,
    }),
  )

  await db.$transaction(async tx => {
    await tx.mediaAsset.upsert({
      where: { id: ids.clipAsset },
      update: {
        state: 'READY',
        bucket: rallyBucket,
        objectKey: clipObjectKey,
        byteLength: clipUpload.byteLength,
        sha256: clipUpload.sha256,
        readyAt: new Date(),
      },
      create: {
        id: ids.clipAsset,
        kind: 'CANONICAL_CLIP',
        bucket: rallyBucket,
        objectKey: clipObjectKey,
        contentType: 'video/mp4',
        byteLength: clipUpload.byteLength,
        sha256: clipUpload.sha256,
        internalSchemaVersion: '1.0.0',
        state: 'READY',
        readyAt: new Date(),
      },
    })
    await tx.mediaAsset.upsert({
      where: { id: ids.timingAsset },
      update: {
        state: 'READY',
        bucket: rallyBucket,
        objectKey: timingObjectKey,
        byteLength: timingUpload.byteLength,
        sha256: timingUpload.sha256,
        readyAt: new Date(),
      },
      create: {
        id: ids.timingAsset,
        kind: 'TIMING_MANIFEST',
        bucket: rallyBucket,
        objectKey: timingObjectKey,
        contentType: 'application/json',
        byteLength: timingUpload.byteLength,
        sha256: timingUpload.sha256,
        internalSchemaVersion: '1.0.0',
        state: 'READY',
        readyAt: new Date(),
      },
    })
    await tx.rally.upsert({
      where: { id: ids.rally },
      update: {
        dvrProgramId: program.id,
        annotationRevision: 252n,
        annotationStatus: 'SUBMITTED',
        scoreResolutionState: 'RESOLVED',
        scoringCourtSide: 'RIGHT',
        scoringTeamId: ids.rightTeam,
        leftScoreBefore: 0,
        rightScoreBefore: 0,
        leftScoreAfter: 0,
        rightScoreAfter: 1,
      },
      create: {
        id: ids.rally,
        matchId: ids.match,
        setId: ids.set,
        dvrProgramId: program.id,
        sideAssignmentId: ids.assignment,
        ordinal: 1,
        annotationRevision: 252n,
        annotationStatus: 'SUBMITTED',
        processingStatus: 'AI_QUEUED',
        scoreResolutionState: 'RESOLVED',
        scoringCourtSide: 'RIGHT',
        scoringTeamId: ids.rightTeam,
        leftScoreBefore: 0,
        rightScoreBefore: 0,
        leftScoreAfter: 0,
        rightScoreAfter: 1,
      },
    })
    for (const [index, item] of points.entries()) {
      const markerKind = item.point.marker_kind.toUpperCase() as 'SERVICE' | 'CONTACT'
      await tx.keyPoint.upsert({
        where: { id: item.point.key_point_id },
        update: {
          captureEpochId: epoch.id,
          sequenceIndex: index,
          markerKind,
          isTerminal: item.point.is_terminal,
          sourcePts: item.sourcePts,
          captureTimeUs: item.captureTimeUs,
          captureFrameIndex: item.captureFrameIndex,
        },
        create: {
          id: item.point.key_point_id,
          rallyId: ids.rally,
          captureEpochId: epoch.id,
          sequenceIndex: index,
          markerKind,
          isTerminal: item.point.is_terminal,
          sourcePts: item.sourcePts,
          captureTimeUs: item.captureTimeUs,
          captureFrameIndex: item.captureFrameIndex,
          timingPrecision: 'FRAME_EXACT',
          originalPlaybackCursor: {
            source: 'contract-lab-import',
            observed_player_time_us: item.captureTimeUs.toString(),
          },
          createdByUserId: ids.user,
          updatedByUserId: ids.user,
          deviceSessionId: ids.device,
        },
      })
    }
    await tx.rallySubmission.upsert({
      where: { id: ids.submission },
      update: { contentHash, status: 'ACTIVE' },
      create: {
        id: ids.submission,
        rallyId: ids.rally,
        annotationRevision: 251n,
        contentHash,
        status: 'ACTIVE',
        scoreResolutionState: 'RESOLVED',
        scoringCourtSide: 'RIGHT',
        scoringTeamId: ids.rightTeam,
        leftTeamId: ids.leftTeam,
        rightTeamId: ids.rightTeam,
        sideAssignmentId: ids.assignment,
        leftScoreBefore: 0,
        rightScoreBefore: 0,
        leftScoreAfter: 0,
        rightScoreAfter: 1,
        scoreRevisionBefore: 0,
        scoreRevisionAfter: 1,
        clipPolicyVersion: 'rally-clip-v1',
        clipPreRollUs: 3_000_000n,
        clipPostRollUs: 3_000_000n,
        submittedByUserId: ids.user,
      },
    })
    for (const [index, item] of points.entries()) {
      const markerKind = item.point.marker_kind.toUpperCase() as 'SERVICE' | 'CONTACT'
      await tx.rallySubmissionKeyPoint.upsert({
        where: { id: item.point.key_point_id },
        update: {
          captureEpochId: epoch.id,
          sourceDraftKeyPointId: item.point.key_point_id,
          sequenceIndex: index,
          markerKind,
          isTerminal: item.point.is_terminal,
          sourcePts: item.sourcePts,
          captureTimeUs: item.captureTimeUs,
          captureFrameIndex: item.captureFrameIndex,
          timingPrecision: 'FRAME_EXACT',
        },
        create: {
          id: item.point.key_point_id,
          submissionId: ids.submission,
          captureEpochId: epoch.id,
          sourceDraftKeyPointId: item.point.key_point_id,
          sequenceIndex: index,
          markerKind,
          isTerminal: item.point.is_terminal,
          sourcePts: item.sourcePts,
          captureTimeUs: item.captureTimeUs,
          captureFrameIndex: item.captureFrameIndex,
          timingPrecision: 'FRAME_EXACT',
        },
      })
    }
    await tx.rallySubmission.update({
      where: { id: ids.submission },
      data: {
        serviceKeyPointId: points[0].point.key_point_id,
        terminalKeyPointId: points.at(-1).point.key_point_id,
      },
    })
    await tx.rally.update({
      where: { id: ids.rally },
      data: { activeSubmissionId: ids.submission, processingStatus: 'AI_QUEUED' },
    })
    await tx.scoreLedgerEntry.upsert({
      where: { id: ids.ledger },
      update: {},
      create: {
        id: ids.ledger,
        kind: 'POINT_AWARD',
        setId: ids.set,
        submissionId: ids.submission,
        leftDelta: 0,
        rightDelta: 1,
        leftScoreBefore: 0,
        rightScoreBefore: 0,
        leftScoreAfter: 0,
        rightScoreAfter: 1,
        scoreRevisionBefore: 0,
        scoreRevisionAfter: 1,
      },
    })
    await tx.pointAward.upsert({
      where: { id: ids.award },
      update: {},
      create: {
        id: ids.award,
        submissionId: ids.submission,
        ledgerEntryId: ids.ledger,
        setId: ids.set,
        scoringTeamId: ids.rightTeam,
        leftScoreBefore: 0,
        rightScoreBefore: 0,
        leftScoreAfter: 0,
        rightScoreAfter: 1,
        scoreRevisionBefore: 0,
        scoreRevisionAfter: 1,
      },
    })
    await tx.clipJob.upsert({
      where: { id: ids.clipJob },
      update: {
        status: 'COMPLETED',
        actualStartCaptureUs: clipStartUs,
        actualEndCaptureUs: clipEndUs,
        clipAssetId: ids.clipAsset,
        timingManifestAssetId: ids.timingAsset,
        completedAt: new Date(),
        leasedUntil: null,
      },
      create: {
        id: ids.clipJob,
        submissionId: ids.submission,
        status: 'COMPLETED',
        idempotencyKey: `contract-lab-demo:${ids.submission}`,
        canonicalizationProfileVersion: 'h264-aac-yuv420p-faststart-v1',
        requestedStartCaptureUs: clipStartUs,
        requestedEndCaptureUs: clipEndUs,
        actualStartCaptureUs: clipStartUs,
        actualEndCaptureUs: clipEndUs,
        clipAssetId: ids.clipAsset,
        timingManifestAssetId: ids.timingAsset,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    })
    for (const item of points)
      await tx.clipKeyPointMapping.upsert({
        where: {
          clipJobId_submissionKeyPointId: {
            clipJobId: ids.clipJob,
            submissionKeyPointId: item.point.key_point_id,
          },
        },
        update: {
          clipPts: BigInt(item.point.clip_pts),
          clipTimeUs: BigInt(item.point.clip_time_us),
          clipFrameIndex: BigInt(item.point.clip_frame_index),
        },
        create: {
          clipJobId: ids.clipJob,
          submissionKeyPointId: item.point.key_point_id,
          clipPts: BigInt(item.point.clip_pts),
          clipTimeUs: BigInt(item.point.clip_time_us),
          clipFrameIndex: BigInt(item.point.clip_frame_index),
        },
      })

    const callbackSecret = process.env.AI_CALLBACK_TOKEN_SECRET ?? ''
    if (callbackSecret.length < 32)
      throw new Error('AI_CALLBACK_TOKEN_SECRET must contain at least 32 characters')
    const callbackToken = createHmac('sha256', callbackSecret)
      .update(`volleyball-ai-callback:${ids.aiJob}`)
      .digest('base64url')
    const basePayload = { ...input, match_id: ids.match, clip: { ...input.clip } }
    delete basePayload.clip.download_url
    delete basePayload.clip.download_url_expires_at
    delete basePayload.callback
    const existingRun = await tx.analysisRun.findUnique({ where: { aiJobId: ids.aiJob } })
    await tx.aiJob.upsert({
      where: { id: ids.aiJob },
      update: existingRun
        ? {}
        : {
            status: 'QUEUED',
            requestPayload: basePayload,
            requestPayloadHash: sha256(stableJson(basePayload)),
            callbackTokenHash: sha256(callbackToken),
            callbackTokenExpiresAt: new Date(Date.now() + 86_400_000),
            availableAt: new Date(),
            leasedUntil: null,
            errorCode: null,
            errorMessage: null,
          },
      create: {
        id: ids.aiJob,
        submissionId: ids.submission,
        clipJobId: ids.clipJob,
        status: 'QUEUED',
        idempotencyKey: `volleyball-analysis-engine:${ids.submission}`,
        requestPayload: basePayload,
        requestPayloadHash: sha256(stableJson(basePayload)),
        jobSchemaVersion: '1.1.0',
        callbackTokenHash: sha256(callbackToken),
        callbackTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    if (existingRun)
      await tx.rally.update({ where: { id: ids.rally }, data: { processingStatus: 'COMPLETED' } })
  })
}

async function waitForAi(db: PrismaClient, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await db.aiJob.findUnique({
      where: { id: ids.aiJob },
      include: { analysisRun: true },
    })
    if (job?.status === 'COMPLETED' && job.analysisRun?.status === 'COMPLETED')
      return job.analysisRun
    if (job?.status === 'FAILED')
      throw new Error(
        `tracking replay failed: ${job.errorCode ?? 'unknown'} ${job.errorMessage ?? ''}`,
      )
    await sleep(1_000)
  }
  throw new Error('tracking replay did not complete in time')
}

async function waitForFullDvr(db: PrismaClient, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const program = await db.dvrProgram.findFirst({
      where: { captureSessionId: ids.capture },
      orderBy: { createdAt: 'asc' },
    })
    if (program && program.durationUs >= sourceDurationUs - 2_500_000n) return program
    await sleep(2_000)
  }
  throw new Error('full 30-minute DVR import did not finish in time')
}

async function main() {
  const root = contractLabRoot()
  const sourcePath = resolve(root, '.data/media/fce9691e-4997-48d5-839a-71ad82b373e2/source.mp4')
  const clipPath = resolve(root, 'ai-team-handoff/input/clip.mp4')
  if (
    (await fileSha256(sourcePath)) !== sourceSha256 ||
    (await fileSha256(clipPath)) !== clipSha256
  )
    throw new Error('Contract Lab source checksum mismatch')

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: localDatabaseUrl() }) })
  const minio = createMinio()
  try {
    await upsertScaffold(db)
    const existing = await db.dvrProgram.findFirst({
      where: { captureSessionId: ids.capture },
      orderBy: { createdAt: 'asc' },
    })
    const spoolRoot = await prepareOfflineDvr(sourcePath)
    if (!existing || existing.durationUs < sourceDurationUs - 2_500_000n)
      await ingestOfflineDvr(db, spoolRoot)
    const timeline = await waitForTimeline(db)
    await createRallyBundle(db, minio, timeline, root)
    const analysis = await waitForAi(db)
    const full = await waitForFullDvr(db)
    console.log(
      JSON.stringify(
        {
          matchId: ids.match,
          rallyId: ids.rally,
          submissionId: ids.submission,
          analysisRunId: analysis.id,
          dvrDurationUs: full.durationUs.toString(),
          provider: 'volleyball-analysis-engine',
        },
        null,
        2,
      ),
    )
  } finally {
    await db.$disconnect()
  }
}

await main()
