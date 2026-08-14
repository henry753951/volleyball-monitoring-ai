import { db } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { parseAnalysisData } from '@volleyball-monitoring/contracts'
import type { FastifyPluginAsync } from 'fastify'
import archiver from 'archiver'
import { Client } from 'minio'
import { extname } from 'node:path'
import {
  buildAnalysisDataDatasetFiles,
  buildPersistedReidDatasetFiles,
  jsonBytes,
  jsonLines,
  ML_DATASET_SCHEMA_VERSION,
  ML_DATASET_README,
  redactAiJobRequest,
  sha256Bytes,
  type GeneratedDatasetFile,
} from '../media/analysis-dataset.js'
import { readClipFrameTimeline, timingManifestIdentity } from '../media/clip-timing-coverage.js'
import type { MediaObjectReader } from '../media/playback-domain.js'
import { authenticateDevelopmentAnnotationRequest } from '../realtime/auth.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function client() { const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000'); const accessKey = process.env.MINIO_ACCESS_KEY; const secretKey = process.env.MINIO_SECRET_KEY; if (!accessKey || !secretKey) throw new Error('MinIO credentials are required'); return new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', accessKey, secretKey, pathStyle: true }) }

async function readObject(storage: Client, bucket: string, objectKey: string, maximumBytes: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of await storage.getObject(bucket, objectKey)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maximumBytes) throw new RangeError(`object exceeds ${maximumBytes} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

export function analysisMediaRoutesWithDependencies(dependencies: { timingManifestReader: MediaObjectReader }): FastifyPluginAsync {
  return async (app) => {
  const storage = client()
  app.get<{ Params: { rallyId: string }; Querystring: { clipJobId?: string } }>('/api/v1/analysis/rallies/:rallyId/clip', async (request, reply) => {
    if (!UUID.test(request.params.rallyId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    if (request.query.clipJobId && !UUID.test(request.query.clipJobId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const clip = await db.clipJob.findFirst({ where: { ...(request.query.clipJobId ? { id: request.query.clipJobId } : {}), status: JobStatus.COMPLETED, submission: { rally: { id: request.params.rallyId, voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } }, clipAsset: { state: ArtifactState.READY, deletedAt: null } }, orderBy: { completedAt: 'desc' }, select: { clipAsset: { select: { bucket: true, objectKey: true, contentType: true, byteLength: true, sha256: true } } } })
    const asset = clip?.clipAsset
    if (!asset || asset.byteLength === null || asset.sha256 === null || asset.byteLength > BigInt(Number.MAX_SAFE_INTEGER)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const total = Number(asset.byteLength)
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    reply.header('Accept-Ranges', 'bytes').header('ETag', `"${asset.sha256}"`).type(asset.contentType)
    if (range) {
      const start = Number(range[1]); const requestedEnd = range[2] ? Number(range[2]) : total - 1; const end = Math.min(requestedEnd, total - 1)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) return reply.status(416).header('Content-Range', `bytes */${total}`).send()
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', String(end - start + 1))
      return reply.send(await storage.getPartialObject(asset.bucket, asset.objectKey, start, end - start + 1))
    }
    reply.header('Content-Length', String(total))
    return reply.send(await storage.getObject(asset.bucket, asset.objectKey))
  })

  app.get<{ Params: { analysisRunId: string } }>('/api/v1/analysis-runs/:analysisRunId/dataset.zip', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const run = await db.analysisRun.findFirst({
      where: {
        id: request.params.analysisRunId,
        status: JobStatus.COMPLETED,
        submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } },
      },
      include: {
        actionCorrections: true,
        artifacts: { include: { asset: true } },
        ballCorrections: true,
        contactActorCorrections: true,
        contactTimeCorrections: true,
        contactEvents: {
          include: {
            actors: true,
            candidates: true,
            representativePositions: true,
            actorCorrection: true,
            timeCorrection: true,
          },
          orderBy: { sequenceIndex: 'asc' },
        },
        playerBBoxCorrections: true,
        rawAnalysisDataAsset: true,
        segments: { include: { positions: true }, orderBy: { sequenceIndex: 'asc' } },
        tracks: {
          include: {
            identityAssignments: {
              include: { rosterEntry: { include: { player: true, team: true } } },
            },
          },
          orderBy: { trackId: 'asc' },
        },
        aiJob: {
          include: {
            callbackReceipts: { orderBy: { receivedAt: 'asc' } },
            clipJob: { include: { clipAsset: true, timingManifest: true } },
            providerInstance: true,
          },
        },
        submission: {
          include: {
            keyPoints: { orderBy: { sequenceIndex: 'asc' } },
            leftTeam: true,
            rightTeam: true,
            scoringTeam: true,
            rally: {
              include: {
                program: {
                  include: {
                    captureSession: {
                      select: {
                        id: true,
                        sourceKind: true,
                        sourceLabel: true,
                        sourceDurationUs: true,
                        ingestPath: true,
                      },
                    },
                  },
                },
                match: {
                  include: {
                    matchTeams: { include: { team: true } },
                    rosterEntries: { include: { player: true, team: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!run?.aiJob.clipJob?.clipAsset) return reply.status(404).send({ code: 'NOT_FOUND' })
    if (!run.rawAnalysisDataAsset || !run.aiJob.clipJob.timingManifest) {
      return reply.status(409).send({ code: 'DATASET_INCOMPLETE', message: 'The completed analysis is missing AnalysisData or its timing manifest.' })
    }

    const [reidObservations, reidCorrections] = await Promise.all([
      db.reidFeatureObservation.findMany({
        where: { analysisRunId: run.id },
        include: {
          reidIdentity: {
            include: {
              bindings: {
                include: { rosterEntry: { include: { player: true, team: true } } },
                orderBy: [
                  { effectiveFromSetNumber: 'asc' },
                  { effectiveFromRallyOrdinal: 'asc' },
                  { identityRevision: 'asc' },
                ],
              },
            },
          },
        },
        orderBy: { trackId: 'asc' },
      }),
      db.reidCorrectionEvent.findMany({
        where: { matchId: run.submission.rally.match.id },
        include: {
          sourceIdentity: { select: { id: true, label: true, slotIndex: true, teamId: true, modelNamespace: true } },
          targetIdentity: { select: { id: true, label: true, slotIndex: true, teamId: true, modelNamespace: true } },
          rosterEntry: { include: { player: true, team: true } },
        },
        orderBy: [{ identityRevision: 'asc' }, { createdAt: 'asc' }],
      }),
    ])

    const assets = [
      { name: 'video/clip.mp4', asset: run.aiJob.clipJob.clipAsset, store: true },
      ...(run.rawAnalysisDataAsset ? [{ name: 'analysis/analysis-data.vad1', asset: run.rawAnalysisDataAsset, store: true }] : []),
      ...(run.aiJob.clipJob.timingManifest ? [{ name: 'analysis/timing-manifest.json', asset: run.aiJob.clipJob.timingManifest, store: false }] : []),
      ...run.artifacts.map((entry, index) => ({ name: `analysis/artifacts/${String(entry.kind).toLowerCase()}-${index + 1}${extname(entry.asset.objectKey)}`, asset: entry.asset, store: true })),
    ].filter(entry => entry.asset.state === ArtifactState.READY && entry.asset.deletedAt === null)
    const seenAssets = new Set<string>()
    const uniqueAssets = assets.filter(entry => seenAssets.has(entry.asset.id) ? false : (seenAssets.add(entry.asset.id), true))
    const analysisDataBytes = await readObject(storage, run.rawAnalysisDataAsset.bucket, run.rawAnalysisDataAsset.objectKey, 512 * 1024 * 1024)
    const analysisData = parseAnalysisData(analysisDataBytes)
    const rawAnalysis = JSON.parse(analysisData.domainJson) as unknown
    const rawExtensions = isRecord(rawAnalysis) && isRecord(rawAnalysis.extensions) ? rawAnalysis.extensions : null
    const reidFeatureBank = rawExtensions && isRecord(rawExtensions.fixed_roster_reid) ? rawExtensions.fixed_roster_reid : null
    const reidFeatureBankPath = reidFeatureBank ? 'reid/fixed-roster-tracklets.json' : null
    let timeline
    try {
      timeline = await readClipFrameTimeline(
        dependencies.timingManifestReader,
        run.aiJob.clipJob.timingManifest,
        timingManifestIdentity(
          run.aiJob.clipJob.id,
          run.aiJob.clipJob.idempotencyKey,
          run.aiJob.clipJob.timingManifest.objectKey,
        ),
      )
    }
    catch (error) {
      request.log.warn({ error, analysisRunId: run.id }, 'ML dataset timing manifest is invalid')
      return reply.status(409).send({ code: 'DATASET_TIMING_INVALID', message: 'The canonical frame timeline could not be verified.' })
    }

    const review = {
      schema_version: '1.2.0',
      analysis_run_id: run.id,
      revision: run.reviewRevision.toString(),
      ball_corrections: run.ballCorrections.map(item => item.visible
        ? { frame_index: item.frameIndex.toString(), state: 'position', frame_pos: { x: item.frameX!, y: item.frameY! }, revision: item.revision.toString() }
        : { frame_index: item.frameIndex.toString(), state: 'missing', frame_pos: null, revision: item.revision.toString() }),
      action_corrections: run.actionCorrections.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, action: item.action, revision: item.revision.toString() })),
      player_bbox_corrections: run.playerBBoxCorrections.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, frame_bbox: { x1: item.frameX1, y1: item.frameY1, x2: item.frameX2, y2: item.frameY2 }, revision: item.revision.toString() })),
      contact_actor_corrections: run.contactActorCorrections.map(item => ({ key_point_id: item.keyPointId, track_id: item.trackId, revision: item.revision.toString() })),
      contact_time_corrections: run.contactTimeCorrections.map(item => ({ key_point_id: item.keyPointId, frame_index: item.frameIndex.toString(), revision: item.revision.toString() })),
    }
    const identityAssignments = run.tracks.flatMap(track => track.identityAssignments.map(assignment => ({
      track_id: track.trackId,
      roster_entry_id: assignment.rosterEntryId,
      source: assignment.source,
      confidence: assignment.confidence,
      reid_identity_id: assignment.reidIdentityId,
      reid_binding_id: assignment.reidBindingId,
      identity_revision: assignment.identityRevision,
      assigned_at: assignment.createdAt,
      player: {
        id: assignment.rosterEntry.player?.id ?? null,
        name: assignment.rosterEntry.displayNameSnapshot ?? assignment.rosterEntry.player?.name ?? null,
        jersey_number: assignment.rosterEntry.jerseyNumber,
        position: assignment.rosterEntry.position,
        team_id: assignment.rosterEntry.teamId,
        team_name: assignment.rosterEntry.team.name,
      },
    })))
    const generated: GeneratedDatasetFile[] = [
      {
        path: 'README.md',
        bytes: Buffer.from(ML_DATASET_README),
        contentType: 'text/markdown; charset=utf-8',
        description: 'Dataset layout, coordinate semantics, and reproducibility boundary.',
      },
      {
        path: 'input/ai-job-request.redacted.json',
        bytes: jsonBytes(redactAiJobRequest(run.aiJob.requestPayload)),
        contentType: 'application/json',
        description: 'Persisted inference request with callback delivery credentials omitted or redacted.',
      },
      {
        path: 'metadata/clip.json',
        bytes: jsonBytes({
          schema_version: '1.0.0',
          clip_job_id: run.aiJob.clipJob.id,
          source: {
            capture_session_id: run.submission.rally.program.captureSessionId,
            kind: run.submission.rally.program.captureSession.sourceKind,
            label: run.submission.rally.program.captureSession.sourceLabel,
            ingest_path: run.submission.rally.program.captureSession.ingestPath,
            source_duration_us: run.submission.rally.program.captureSession.sourceDurationUs,
            dvr_program_id: run.submission.rally.dvrProgramId,
            dvr_program: {
              duration_us: run.submission.rally.program.durationUs,
              fps: {
                num: run.submission.rally.program.fpsNum,
                den: run.submission.rally.program.fpsDen,
              },
              time_base: {
                num: run.submission.rally.program.timeBaseNum,
                den: run.submission.rally.program.timeBaseDen,
              },
            },
            requested_capture_range_us: {
              start: run.aiJob.clipJob.requestedStartCaptureUs,
              end: run.aiJob.clipJob.requestedEndCaptureUs,
            },
            actual_capture_range_us: {
              start: run.aiJob.clipJob.actualStartCaptureUs,
              end: run.aiJob.clipJob.actualEndCaptureUs,
            },
          },
          cut: {
            policy_version: run.submission.clipPolicyVersion,
            pre_roll_us: run.submission.clipPreRollUs,
            post_roll_us: run.submission.clipPostRollUs,
            canonicalization_profile_version: run.aiJob.clipJob.canonicalizationProfileVersion,
          },
          video: isRecord(run.aiJob.requestPayload) && isRecord(run.aiJob.requestPayload.clip)
            ? run.aiJob.requestPayload.clip.video ?? null
            : null,
          asset: {
            id: run.aiJob.clipJob.clipAsset.id,
            content_type: run.aiJob.clipJob.clipAsset.contentType,
            byte_length: run.aiJob.clipJob.clipAsset.byteLength,
            sha256: run.aiJob.clipJob.clipAsset.sha256,
          },
        }),
        contentType: 'application/json',
        description: 'Canonical clip, source capture range, cut policy, video properties, and immutable asset checksum.',
      },
      {
        path: 'metadata/run.json',
        bytes: jsonBytes({
          schema_version: '1.0.0',
          analysis_run: {
            id: run.id,
            analysis_id: run.analysisId,
            analysis_version: run.analysisVersion,
            analysis_data_schema_version: run.analysisDataSchemaVersion,
            input_clip_sha256: run.inputClipSha256,
            producer: { name: run.producerName, build_id: run.producerBuildId, sdk_version: run.producerSdkVersion },
            summary: run.summary,
            created_at: run.createdAt,
            activated_at: run.activatedAt,
            superseded_at: run.supersededAt,
            review_revision: run.reviewRevision,
          },
          ai_job: {
            id: run.aiJob.id,
            schema_version: run.aiJob.jobSchemaVersion,
            request_sha256: run.aiJob.requestPayloadHash,
            status: run.aiJob.status,
            attempt_count: run.aiJob.attemptCount,
            provider_job_id: run.aiJob.providerJobId,
            accepted_at: run.aiJob.acceptedAt,
            started_at: run.aiJob.startedAt,
            completed_at: run.aiJob.completedAt,
            created_at: run.aiJob.createdAt,
            updated_at: run.aiJob.updatedAt,
          },
          provider_instance: run.aiJob.providerInstance ? {
            instance_key: run.aiJob.providerInstance.instanceKey,
            sdk_version: run.aiJob.providerInstance.sdkVersion,
            provider_build_id: run.aiJob.providerInstance.providerBuildId,
            capabilities: run.aiJob.providerInstance.capabilities,
            max_concurrency: run.aiJob.providerInstance.maxConcurrency,
          } : null,
          analysis_data_identity: {
            embedded_analysis_id: analysisData.analysisId,
            embedded_analysis_version: analysisData.analysisVersion,
            schema_version: analysisData.schemaVersion,
          },
        }),
        contentType: 'application/json',
        description: 'Analysis, AI job, provider build, and model capability metadata.',
      },
      {
        path: 'metadata/progress-events.jsonl',
        bytes: jsonLines(run.aiJob.callbackReceipts.map(receipt => ({
          callback_id: receipt.callbackId,
          kind: receipt.kind,
          received_at: receipt.receivedAt,
          metadata: receipt.requestMetadata,
        }))),
        contentType: 'application/x-ndjson',
        description: 'Persisted processing/completion callbacks for stage timing analysis.',
      },
      {
        path: 'metadata/submission.json',
        bytes: jsonBytes({
          id: run.submission.id,
          rally_id: run.submission.rallyId,
          annotation_revision: run.submission.annotationRevision,
          content_sha256: run.submission.contentHash,
          status: run.submission.status,
          submitted_at: run.submission.submittedAt,
          outcome: {
            score_resolution_state: run.submission.scoreResolutionState,
            scoring_court_side: run.submission.scoringCourtSide,
            scoring_team_id: run.submission.scoringTeamId,
            left_score_before: run.submission.leftScoreBefore,
            right_score_before: run.submission.rightScoreBefore,
            left_score_after: run.submission.leftScoreAfter,
            right_score_after: run.submission.rightScoreAfter,
          },
          court_sides: {
            left_team: run.submission.leftTeam,
            right_team: run.submission.rightTeam,
            side_assignment_id: run.submission.sideAssignmentId,
            reversed: run.submission.sideAssignmentReversed,
          },
          clip_policy: {
            version: run.submission.clipPolicyVersion,
            pre_roll_us: run.submission.clipPreRollUs,
            post_roll_us: run.submission.clipPostRollUs,
          },
          key_points: run.submission.keyPoints,
        }),
        contentType: 'application/json',
        description: 'Immutable human annotation submission and canonical source anchors.',
      },
      {
        path: 'metadata/match.json',
        bytes: jsonBytes({
          id: run.submission.rally.match.id,
          title: run.submission.rally.match.title,
          venue: run.submission.rally.match.venue,
          scheduled_at: run.submission.rally.match.scheduledAt,
          identity_revision: run.submission.rally.match.identityRevision,
          teams: run.submission.rally.match.matchTeams.map(entry => entry.team),
          roster: run.submission.rally.match.rosterEntries.map(entry => ({
            id: entry.id,
            team_id: entry.teamId,
            team_name: entry.team.name,
            player_id: entry.playerId,
            player_name: entry.displayNameSnapshot ?? entry.player?.name ?? null,
            jersey_number: entry.jerseyNumber,
            position: entry.position,
            active: entry.active,
          })),
        }),
        contentType: 'application/json',
        description: 'Match, team, and roster snapshot used for identity experiments.',
      },
      {
        path: 'labels/review-corrections.jsonl',
        bytes: jsonLines([
          ...review.ball_corrections.map(value => ({ kind: 'ball', ...value })),
          ...review.action_corrections.map(value => ({ kind: 'action', ...value })),
          ...review.player_bbox_corrections.map(value => ({ kind: 'player_bbox', ...value })),
          ...review.contact_actor_corrections.map(value => ({ kind: 'contact_actor', ...value })),
          ...review.contact_time_corrections.map(value => ({ kind: 'contact_time', ...value })),
        ]),
        contentType: 'application/x-ndjson',
        description: 'Complete sparse current human review state; values override predictions at the same key.',
      },
      {
        path: 'labels/identity-assignments.jsonl',
        bytes: jsonLines(identityAssignments.map(assignment => ({ schema_version: '1.0.0', ...assignment }))),
        contentType: 'application/x-ndjson',
        description: 'Current track-to-roster identity assignments and provenance.',
      },
      ...buildPersistedReidDatasetFiles({
        analysisRunId: run.id,
        matchId: run.submission.rally.match.id,
        matchIdentityRevision: run.submission.rally.match.identityRevision,
        observations: reidObservations,
        corrections: reidCorrections,
        featureBankPath: reidFeatureBankPath,
      }),
      ...(reidFeatureBank ? [{
        path: reidFeatureBankPath!,
        bytes: jsonBytes(reidFeatureBank),
        contentType: 'application/json',
        description: 'Versioned fixed-roster tracklets with DINOv2, Sports OSNet, Official KPR, prompted KPR, aliases, and co-visibility constraints.',
      }] : []),
      {
        path: 'analysis/database-view.json',
        bytes: jsonBytes({
          schema_version: '1.0.0',
          tracks: run.tracks.map(({ identityAssignments: _identityAssignments, ...track }) => track),
          contact_events: run.contactEvents,
          ball_path_segments: run.segments,
        }),
        contentType: 'application/json',
        description: 'Normalized relational view ingested from the raw AI result with correction links.',
      },
      ...buildAnalysisDataDatasetFiles(analysisData, timeline),
    ]
    const manifest = {
      schema_version: ML_DATASET_SCHEMA_VERSION,
      dataset_kind: 'ml_experiment_bundle',
      analysis_run_id: run.id,
      analysis_id: run.analysisId,
      analysis_version: run.analysisVersion,
      producer: { name: run.producerName, build_id: run.producerBuildId, sdk_version: run.producerSdkVersion },
      input_clip_sha256: run.inputClipSha256,
      review_revision: run.reviewRevision.toString(),
      identity_revision: run.submission.rally.match.identityRevision.toString(),
      integrity: {
        algorithm: 'sha256',
        scope: 'Every entry in files; manifest.json is excluded to avoid a self-referential checksum.',
      },
      coverage: {
        all_persisted_inference_outputs: true,
        raw_authoritative_files: ['analysis/analysis-data.vad1', 'analysis/timing-manifest.json'],
        generated_ml_tables: generated.filter(entry => entry.path.endsWith('.jsonl')).map(entry => entry.path),
        generated_label_files: generated.filter(entry => entry.path.startsWith('labels/') || entry.path.startsWith('reid/')).map(entry => entry.path),
        persisted_fixed_roster_reid: Boolean(reidFeatureBank),
        persisted_reid_observation_count: reidObservations.length,
        identity_correction_event_count: reidCorrections.length,
        reid_feature_vector_locations: reidFeatureBankPath
          ? ['analysis/analysis-data.vad1', reidFeatureBankPath]
          : ['analysis/analysis-data.vad1'],
        excluded_transient_worker_state: ['gpu_tensors', 'feature_maps', 'per_frame_detection_embeddings', 'process_memory', 'worker_local_debug_previews', 'worker_logs'],
      },
      files: [
        ...uniqueAssets.map(entry => ({ path: entry.name, byte_length: entry.asset.byteLength?.toString() ?? null, sha256: entry.asset.sha256, content_type: entry.asset.contentType, generated: false })),
        ...generated.map(entry => ({ path: entry.path, byte_length: String(entry.bytes.byteLength), sha256: sha256Bytes(entry.bytes), content_type: entry.contentType, generated: true, description: entry.description })),
      ],
    }

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.on('warning', error => request.log.warn({ error, analysisRunId: run.id }, 'dataset zip warning'))
    archive.on('error', error => request.log.error({ error, analysisRunId: run.id }, 'dataset zip failed'))
    archive.append(jsonBytes(manifest), { name: 'manifest.json' })
    for (const entry of generated) archive.append(entry.bytes, { name: entry.path })
    for (const entry of uniqueAssets) {
      archive.append(entry.asset.id === run.rawAnalysisDataAssetId ? analysisDataBytes : await storage.getObject(entry.asset.bucket, entry.asset.objectKey), { name: entry.name, store: entry.store })
    }
    const baseName = `${run.submission.rally.match.title}-${run.submission.rally.id}`.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120)
    reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-dataset.zip`)}`)
      .type('application/zip')
    void archive.finalize()
    return reply.send(archive)
  })

  app.get<{ Params: { analysisRunId: string } }>('/api/v1/analysis-runs/:analysisRunId/analysis-data-manifest', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const manifest = await db.analysisDataManifest.findFirst({
      where: { analysisRunId: request.params.analysisRunId, analysisRun: { status: JobStatus.COMPLETED, submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } } } },
      include: {
        chunks: { where: { asset: { state: ArtifactState.READY, deletedAt: null } }, include: { asset: { select: { contentType: true } } }, orderBy: { chunkIndex: 'asc' } },
        analysisRun: {
          select: {
            analysisId: true,
            aiJob: {
              select: {
                requestPayload: true,
                clipJob: {
                  select: {
                    id: true,
                    idempotencyKey: true,
                    timingManifest: { select: { bucket: true, objectKey: true, contentType: true, byteLength: true, sha256: true, internalSchemaVersion: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!manifest) return reply.status(404).send({ code: 'NOT_FOUND' })
    const clipJob = manifest.analysisRun.aiJob.clipJob
    let frameTiming: {
      capture_time_us: string[]
      capture_end_time_us: string
      clip_time_us: string[]
      clip_end_time_us: string
    } | null = null
    if (clipJob.timingManifest) {
      try {
        const timeline = await readClipFrameTimeline(
          dependencies.timingManifestReader,
          clipJob.timingManifest,
          timingManifestIdentity(
            clipJob.id,
            clipJob.idempotencyKey,
            clipJob.timingManifest.objectKey,
          ),
        )
        if (BigInt(timeline.clipTimeUs.length) !== manifest.totalFrames) throw new Error('AnalysisData and timing manifest frame counts differ')
        frameTiming = {
          capture_time_us: timeline.captureTimeUs.map(value => value.toString()),
          capture_end_time_us: timeline.captureEndUs.toString(),
          clip_time_us: timeline.clipTimeUs.map(value => value.toString()),
          clip_end_time_us: timeline.clipEndUs.toString(),
        }
      }
      catch (error) {
        request.log.warn({ error, analysisRunId: manifest.analysisRunId }, 'Exact AnalysisData frame timeline is unavailable')
      }
    }
    return reply.header('Cache-Control', 'private, no-store').send({
      schema_version: manifest.schemaVersion,
      analysis_id: manifest.analysisRun.analysisId,
      analysis_data_version: manifest.analysisDataVersion,
      video: { width: manifest.videoWidth, height: manifest.videoHeight, fps: { num: manifest.fpsNum, den: manifest.fpsDen }, total_frames: manifest.totalFrames.toString() },
      frame_timing: frameTiming,
      chunk_frame_count: manifest.chunkFrameCount,
      chunks: manifest.chunks.map(chunk => ({ chunk_index: chunk.chunkIndex, start_frame_index: chunk.startFrameIndex.toString(), frame_count: chunk.frameCount, url: `/api/v1/analysis-runs/${manifest.analysisRunId}/analysis-frame-chunks/${chunk.chunkIndex}`, byte_length: chunk.byteLength.toString(), sha256: chunk.sha256 })),
      action_taxonomy: manifest.actionTaxonomy,
    })
  })

  app.get<{ Params: { analysisRunId: string; chunkIndex: string } }>('/api/v1/analysis-runs/:analysisRunId/analysis-frame-chunks/:chunkIndex', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId) || !/^(0|[1-9][0-9]*)$/.test(request.params.chunkIndex)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const chunkIndex = Number(request.params.chunkIndex)
    if (!Number.isSafeInteger(chunkIndex)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const chunk = await db.analysisFrameChunk.findFirst({
      where: { analysisRunId: request.params.analysisRunId, chunkIndex, manifest: { analysisRun: { status: JobStatus.COMPLETED, submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } } } }, asset: { state: ArtifactState.READY, deletedAt: null } },
      include: { asset: { select: { bucket: true, objectKey: true, contentType: true } } },
    })
    if (!chunk) return reply.status(404).send({ code: 'NOT_FOUND' })
    return reply.header('Cache-Control', 'private, max-age=300').header('Content-Length', chunk.byteLength.toString()).header('ETag', `"${chunk.sha256}"`).type(chunk.asset.contentType).send(await storage.getObject(chunk.asset.bucket, chunk.asset.objectKey))
  })
  }
}
