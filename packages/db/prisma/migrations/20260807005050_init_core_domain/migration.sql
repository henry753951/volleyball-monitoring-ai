-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'ANNOTATOR', 'COACH', 'VIEWER');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PLANNED', 'LIVE', 'FINISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SetStatus" AS ENUM ('PLANNED', 'LIVE', 'FINISHED');

-- CreateEnum
CREATE TYPE "CaptureStatus" AS ENUM ('STARTING', 'LIVE', 'STOPPING', 'FINISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceHealth" AS ENUM ('STARTING', 'HEALTHY', 'DEGRADED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "CourtSide" AS ENUM ('LEFT', 'RIGHT');

-- CreateEnum
CREATE TYPE "TrackCourtSide" AS ENUM ('LEFT', 'RIGHT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MarkerKind" AS ENUM ('SERVICE', 'CONTACT');

-- CreateEnum
CREATE TYPE "TimingPrecision" AS ENUM ('FRAME_EXACT', 'PTS_EXACT', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "ScoreResolutionState" AS ENUM ('PENDING', 'RESOLVED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SubmissionScoreResolution" AS ENUM ('RESOLVED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnnotationStatus" AS ENUM ('OPEN', 'READY', 'SUBMITTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('IDLE', 'CLIP_QUEUED', 'CLIPPING', 'AI_QUEUED', 'AI_PROCESSING', 'ARTIFACT_INGESTING', 'COMPLETED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ArtifactState" AS ENUM ('UPLOADING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('RAW_RECORDING', 'DVR_INIT', 'DVR_SEGMENT', 'SAMPLE_INDEX', 'CANONICAL_CLIP', 'PREVIEW_CLIP', 'TIMING_MANIFEST', 'ANALYSIS_JSON', 'OVERLAY_SEQUENCE', 'OVERLAY_CHUNK');

-- CreateEnum
CREATE TYPE "AssociationState" AS ENUM ('RESOLVED_SINGLE', 'RESOLVED_MULTIPLE', 'AMBIGUOUS', 'UNRESOLVED', 'NO_PLAYER');

-- CreateEnum
CREATE TYPE "BallObservationState" AS ENUM ('OBSERVED', 'INTERPOLATED', 'MISSING');

-- CreateEnum
CREATE TYPE "SegmentRenderState" AS ENUM ('COMPLETE', 'PARTIAL', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "SegmentEndpoint" AS ENUM ('START', 'END');

-- CreateEnum
CREATE TYPE "IdentitySource" AS ENUM ('MANUAL', 'AI', 'PROPAGATED');

-- CreateEnum
CREATE TYPE "CallbackKind" AS ENUM ('PROCESSING', 'FAILED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMember" (
    "matchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "UserRole" NOT NULL,

    CONSTRAINT "MatchMember_pkey" PRIMARY KEY ("matchId","userId")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "venue" TEXT,
    "status" "MatchStatus" NOT NULL DEFAULT 'PLANNED',
    "scheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchTeam" (
    "matchId" UUID NOT NULL,
    "teamId" UUID NOT NULL,

    CONSTRAINT "MatchTeam_pkey" PRIMARY KEY ("matchId","teamId")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchRosterEntry" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "playerId" UUID,
    "jerseyNumber" TEXT NOT NULL,
    "displayNameSnapshot" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchRosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchSet" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "setNumber" INTEGER NOT NULL,
    "status" "SetStatus" NOT NULL DEFAULT 'PLANNED',
    "leftScore" INTEGER NOT NULL DEFAULT 0,
    "rightScore" INTEGER NOT NULL DEFAULT 0,
    "scoreRevision" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtSideAssignment" (
    "id" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "effectiveFromRallyOrdinal" INTEGER NOT NULL,
    "effectiveToRallyOrdinal" INTEGER,
    "leftTeamId" UUID NOT NULL,
    "rightTeamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourtSideAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureSession" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "sourceConfigSecretRef" TEXT,
    "ingestPath" TEXT NOT NULL,
    "status" "CaptureStatus" NOT NULL DEFAULT 'STARTING',
    "health" "SourceHealth" NOT NULL DEFAULT 'STARTING',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureEpoch" (
    "id" UUID NOT NULL,
    "captureSessionId" UUID NOT NULL,
    "sequenceIndex" INTEGER NOT NULL,
    "sourceTimeBaseNum" INTEGER NOT NULL,
    "sourceTimeBaseDen" INTEGER NOT NULL,
    "sourcePtsOrigin" BIGINT NOT NULL,
    "captureTimeOriginUs" BIGINT NOT NULL,
    "captureFrameOrigin" BIGINT NOT NULL,
    "startedAtCaptureUs" BIGINT NOT NULL,
    "endedAtCaptureUs" BIGINT,
    "discontinuityReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptureEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DvrProgram" (
    "id" UUID NOT NULL,
    "captureSessionId" UUID NOT NULL,
    "status" "CaptureStatus" NOT NULL DEFAULT 'STARTING',
    "playlistRevision" BIGINT NOT NULL DEFAULT 0,
    "liveEdgeUs" BIGINT NOT NULL DEFAULT 0,
    "durationUs" BIGINT NOT NULL DEFAULT 0,
    "fpsNum" INTEGER NOT NULL,
    "fpsDen" INTEGER NOT NULL,
    "timeBaseNum" INTEGER NOT NULL,
    "timeBaseDen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DvrProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteLength" BIGINT,
    "sha256" TEXT,
    "state" "ArtifactState" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DvrSegment" (
    "id" UUID NOT NULL,
    "dvrProgramId" UUID NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sequenceNumber" BIGINT NOT NULL,
    "discontinuitySequence" INTEGER NOT NULL DEFAULT 0,
    "captureStartUs" BIGINT NOT NULL,
    "captureEndUs" BIGINT NOT NULL,
    "sourcePtsStart" BIGINT,
    "sourcePtsEnd" BIGINT,
    "firstFrameIndex" BIGINT,
    "frameCount" BIGINT NOT NULL,
    "durationUs" BIGINT NOT NULL,
    "isGap" BOOLEAN NOT NULL DEFAULT false,
    "initAssetId" UUID,
    "mediaAssetId" UUID,
    "sampleIndexAssetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "DvrSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rally" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "dvrProgramId" UUID NOT NULL,
    "sideAssignmentId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "annotationRevision" BIGINT NOT NULL DEFAULT 0,
    "annotationStatus" "AnnotationStatus" NOT NULL DEFAULT 'OPEN',
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'IDLE',
    "scoreResolutionState" "ScoreResolutionState" NOT NULL DEFAULT 'PENDING',
    "scoringCourtSide" "CourtSide",
    "scoringTeamId" UUID,
    "leftScoreBefore" INTEGER,
    "rightScoreBefore" INTEGER,
    "leftScoreAfter" INTEGER,
    "rightScoreAfter" INTEGER,
    "activeSubmissionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "Rally_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyPoint" (
    "id" UUID NOT NULL,
    "rallyId" UUID NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sequenceIndex" INTEGER NOT NULL,
    "markerKind" "MarkerKind" NOT NULL,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "sourcePts" BIGINT NOT NULL,
    "captureTimeUs" BIGINT NOT NULL,
    "captureFrameIndex" BIGINT NOT NULL,
    "timingPrecision" "TimingPrecision" NOT NULL,
    "originalPlaybackCursor" JSONB NOT NULL,
    "snapDistanceUs" BIGINT,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "deviceSessionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "KeyPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnotationOperation" (
    "id" UUID NOT NULL,
    "rallyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceSessionId" UUID NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "baseRevision" BIGINT NOT NULL,
    "resultRevision" BIGINT NOT NULL,
    "operationKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnotationOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RallySubmission" (
    "id" UUID NOT NULL,
    "rallyId" UUID NOT NULL,
    "annotationRevision" BIGINT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'ACTIVE',
    "scoreResolutionState" "SubmissionScoreResolution" NOT NULL,
    "scoringCourtSide" "CourtSide",
    "scoringTeamId" UUID,
    "leftTeamId" UUID NOT NULL,
    "rightTeamId" UUID NOT NULL,
    "sideAssignmentId" UUID NOT NULL,
    "leftScoreBefore" INTEGER,
    "rightScoreBefore" INTEGER,
    "leftScoreAfter" INTEGER,
    "rightScoreAfter" INTEGER,
    "scoreRevisionBefore" INTEGER,
    "scoreRevisionAfter" INTEGER,
    "clipPolicyVersion" TEXT NOT NULL,
    "clipPreRollUs" BIGINT NOT NULL,
    "clipPostRollUs" BIGINT NOT NULL,
    "serviceKeyPointId" UUID,
    "terminalKeyPointId" UUID,
    "submittedByUserId" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesSubmissionId" UUID,

    CONSTRAINT "RallySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RallySubmissionKeyPoint" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sourceDraftKeyPointId" UUID NOT NULL,
    "sequenceIndex" INTEGER NOT NULL,
    "markerKind" "MarkerKind" NOT NULL,
    "isTerminal" BOOLEAN NOT NULL,
    "sourcePts" BIGINT NOT NULL,
    "captureTimeUs" BIGINT NOT NULL,
    "captureFrameIndex" BIGINT NOT NULL,
    "timingPrecision" "TimingPrecision" NOT NULL,

    CONSTRAINT "RallySubmissionKeyPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointAward" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "scoringTeamId" UUID NOT NULL,
    "leftScoreBefore" INTEGER NOT NULL,
    "rightScoreBefore" INTEGER NOT NULL,
    "leftScoreAfter" INTEGER NOT NULL,
    "rightScoreAfter" INTEGER NOT NULL,
    "scoreRevisionBefore" INTEGER NOT NULL,
    "scoreRevisionAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointAward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipJob" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "clipSchemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "canonicalizationProfileVersion" TEXT NOT NULL,
    "requestedStartCaptureUs" BIGINT NOT NULL,
    "requestedEndCaptureUs" BIGINT NOT NULL,
    "actualStartCaptureUs" BIGINT,
    "actualEndCaptureUs" BIGINT,
    "clipAssetId" UUID,
    "timingManifestAssetId" UUID,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipKeyPointMapping" (
    "clipJobId" UUID NOT NULL,
    "submissionKeyPointId" UUID NOT NULL,
    "clipPts" BIGINT NOT NULL,
    "clipTimeUs" BIGINT NOT NULL,
    "clipFrameIndex" BIGINT NOT NULL,

    CONSTRAINT "ClipKeyPointMapping_pkey" PRIMARY KEY ("clipJobId","submissionKeyPointId")
);

-- CreateTable
CREATE TABLE "AiIntegration" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capabilitiesUrl" TEXT,
    "submitUrl" TEXT NOT NULL,
    "authSecretRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "jobSchemaVersion" TEXT NOT NULL DEFAULT '1.1.0',
    "resultSchemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "overlayFormat" TEXT NOT NULL DEFAULT 'flatbuffers_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiJob" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "clipJobId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "requestPayloadHash" TEXT NOT NULL,
    "jobSchemaVersion" TEXT NOT NULL,
    "callbackTokenHash" TEXT NOT NULL,
    "callbackTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "providerJobId" TEXT,
    "progress" DOUBLE PRECISION,
    "stage" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastCallbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallbackReceipt" (
    "id" UUID NOT NULL,
    "aiJobId" UUID NOT NULL,
    "callbackId" UUID NOT NULL,
    "kind" "CallbackKind" NOT NULL,
    "requestContentType" TEXT NOT NULL,
    "requestMetadata" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallbackReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" UUID NOT NULL,
    "aiJobId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "analysisId" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "resultSchemaVersion" TEXT NOT NULL,
    "overlaySchemaVersion" TEXT NOT NULL,
    "inputClipSha256" TEXT NOT NULL,
    "producerName" TEXT NOT NULL,
    "producerBuildId" TEXT NOT NULL,
    "producerSdkVersion" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "rawAnalysisAssetId" UUID,
    "rawOverlayAssetId" UUID,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisArtifact" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "assetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisTrack" (
    "analysisRunId" UUID NOT NULL,
    "trackId" INTEGER NOT NULL,
    "courtSide" "TrackCourtSide" NOT NULL DEFAULT 'UNKNOWN',
    "firstFrame" BIGINT NOT NULL,
    "lastFrame" BIGINT NOT NULL,
    "meanConfidence" DOUBLE PRECISION,
    "metadata" JSONB,

    CONSTRAINT "AnalysisTrack_pkey" PRIMARY KEY ("analysisRunId","trackId")
);

-- CreateTable
CREATE TABLE "ContactEvent" (
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "sequenceIndex" INTEGER NOT NULL,
    "anchorFrameIndex" BIGINT NOT NULL,
    "resolvedFrameIndex" BIGINT,
    "anchorTimeUs" BIGINT NOT NULL,
    "markerKind" "MarkerKind" NOT NULL,
    "isTerminal" BOOLEAN NOT NULL,
    "associationState" "AssociationState" NOT NULL,
    "ballState" "BallObservationState" NOT NULL,
    "ballFrameIndex" BIGINT,
    "ballFrameX" DOUBLE PRECISION,
    "ballFrameY" DOUBLE PRECISION,
    "qualityFlags" TEXT[],

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("analysisRunId","keyPointId")
);

-- CreateTable
CREATE TABLE "ContactEventActor" (
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "trackId" INTEGER NOT NULL,
    "observationFrameIndex" BIGINT NOT NULL,
    "associationConfidence" DOUBLE PRECISION,
    "frameX1" DOUBLE PRECISION,
    "frameY1" DOUBLE PRECISION,
    "frameX2" DOUBLE PRECISION,
    "frameY2" DOUBLE PRECISION,
    "frameFootX" DOUBLE PRECISION,
    "frameFootY" DOUBLE PRECISION,
    "courtX" DOUBLE PRECISION,
    "courtY" DOUBLE PRECISION,
    "action" JSONB,

    CONSTRAINT "ContactEventActor_pkey" PRIMARY KEY ("analysisRunId","keyPointId","trackId")
);

-- CreateTable
CREATE TABLE "ContactEventCandidate" (
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "trackId" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "ContactEventCandidate_pkey" PRIMARY KEY ("analysisRunId","keyPointId","trackId")
);

-- CreateTable
CREATE TABLE "ContactEventPosition" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "positionIndex" INTEGER NOT NULL,
    "trackId" INTEGER,
    "basis" TEXT NOT NULL,
    "courtX" DOUBLE PRECISION NOT NULL,
    "courtY" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "ContactEventPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallPathSegment" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "sequenceIndex" INTEGER NOT NULL,
    "startKeyPointId" UUID NOT NULL,
    "endKeyPointId" UUID NOT NULL,
    "startFrameIndex" BIGINT,
    "endFrameIndex" BIGINT,
    "renderState" "SegmentRenderState" NOT NULL,
    "isTerminalSegment" BOOLEAN NOT NULL DEFAULT false,
    "qualityFlags" TEXT[],

    CONSTRAINT "BallPathSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallPathSegmentPosition" (
    "segmentId" UUID NOT NULL,
    "endpoint" "SegmentEndpoint" NOT NULL,
    "positionIndex" INTEGER NOT NULL,
    "trackId" INTEGER,
    "basis" TEXT NOT NULL,
    "courtX" DOUBLE PRECISION NOT NULL,
    "courtY" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "BallPathSegmentPosition_pkey" PRIMARY KEY ("segmentId","endpoint","positionIndex")
);

-- CreateTable
CREATE TABLE "TrackIdentityAssignment" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "trackId" INTEGER NOT NULL,
    "rosterEntryId" UUID NOT NULL,
    "source" "IdentitySource" NOT NULL,
    "assignedByUserId" UUID,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackIdentityAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedAnalysisView" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filterSchemaVersion" TEXT NOT NULL,
    "overlayPresetVersion" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "layout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedAnalysisView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MatchRosterEntry_matchId_teamId_jerseyNumber_key" ON "MatchRosterEntry"("matchId", "teamId", "jerseyNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MatchSet_matchId_setNumber_key" ON "MatchSet"("matchId", "setNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CourtSideAssignment_setId_effectiveFromRallyOrdinal_key" ON "CourtSideAssignment"("setId", "effectiveFromRallyOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "CaptureSession_ingestPath_key" ON "CaptureSession"("ingestPath");

-- CreateIndex
CREATE INDEX "CaptureEpoch_captureSessionId_startedAtCaptureUs_endedAtCap_idx" ON "CaptureEpoch"("captureSessionId", "startedAtCaptureUs", "endedAtCaptureUs");

-- CreateIndex
CREATE UNIQUE INDEX "CaptureEpoch_captureSessionId_sequenceIndex_key" ON "CaptureEpoch"("captureSessionId", "sequenceIndex");

-- CreateIndex
CREATE INDEX "MediaAsset_kind_state_createdAt_idx" ON "MediaAsset"("kind", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_bucket_objectKey_key" ON "MediaAsset"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "DvrSegment_dvrProgramId_captureStartUs_captureEndUs_idx" ON "DvrSegment"("dvrProgramId", "captureStartUs", "captureEndUs");

-- CreateIndex
CREATE UNIQUE INDEX "DvrSegment_dvrProgramId_sequenceNumber_key" ON "DvrSegment"("dvrProgramId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Rally_activeSubmissionId_key" ON "Rally"("activeSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Rally_setId_ordinal_key" ON "Rally"("setId", "ordinal");

-- CreateIndex
CREATE INDEX "KeyPoint_rallyId_captureTimeUs_idx" ON "KeyPoint"("rallyId", "captureTimeUs");

-- CreateIndex
CREATE UNIQUE INDEX "KeyPoint_rallyId_sequenceIndex_key" ON "KeyPoint"("rallyId", "sequenceIndex");

-- CreateIndex
CREATE UNIQUE INDEX "AnnotationOperation_clientMutationId_key" ON "AnnotationOperation"("clientMutationId");

-- CreateIndex
CREATE INDEX "AnnotationOperation_rallyId_resultRevision_idx" ON "AnnotationOperation"("rallyId", "resultRevision");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmission_serviceKeyPointId_key" ON "RallySubmission"("serviceKeyPointId");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmission_terminalKeyPointId_key" ON "RallySubmission"("terminalKeyPointId");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmission_rallyId_annotationRevision_key" ON "RallySubmission"("rallyId", "annotationRevision");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmission_rallyId_contentHash_key" ON "RallySubmission"("rallyId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmissionKeyPoint_submissionId_sequenceIndex_key" ON "RallySubmissionKeyPoint"("submissionId", "sequenceIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RallySubmissionKeyPoint_submissionId_sourceDraftKeyPointId_key" ON "RallySubmissionKeyPoint"("submissionId", "sourceDraftKeyPointId");

-- CreateIndex
CREATE UNIQUE INDEX "PointAward_submissionId_key" ON "PointAward"("submissionId");

-- CreateIndex
CREATE INDEX "PointAward_setId_createdAt_idx" ON "PointAward"("setId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointAward_setId_scoreRevisionAfter_key" ON "PointAward"("setId", "scoreRevisionAfter");

-- CreateIndex
CREATE UNIQUE INDEX "ClipJob_idempotencyKey_key" ON "ClipJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ClipJob_status_availableAt_idx" ON "ClipJob"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClipKeyPointMapping_clipJobId_clipFrameIndex_key" ON "ClipKeyPointMapping"("clipJobId", "clipFrameIndex");

-- CreateIndex
CREATE UNIQUE INDEX "AiIntegration_name_key" ON "AiIntegration"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AiJob_idempotencyKey_key" ON "AiJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AiJob_status_availableAt_idx" ON "AiJob"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCallbackReceipt_callbackId_key" ON "AiCallbackReceipt"("callbackId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_aiJobId_key" ON "AnalysisRun"("aiJobId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_analysisId_key" ON "AnalysisRun"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisArtifact_analysisRunId_kind_assetId_key" ON "AnalysisArtifact"("analysisRunId", "kind", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEvent_analysisRunId_sequenceIndex_key" ON "ContactEvent"("analysisRunId", "sequenceIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEventCandidate_analysisRunId_keyPointId_rank_key" ON "ContactEventCandidate"("analysisRunId", "keyPointId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEventPosition_analysisRunId_keyPointId_positionIndex_key" ON "ContactEventPosition"("analysisRunId", "keyPointId", "positionIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BallPathSegment_analysisRunId_sequenceIndex_key" ON "BallPathSegment"("analysisRunId", "sequenceIndex");

-- CreateIndex
CREATE UNIQUE INDEX "TrackIdentityAssignment_analysisRunId_trackId_key" ON "TrackIdentityAssignment"("analysisRunId", "trackId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedAnalysisView_userId_matchId_name_key" ON "SavedAnalysisView"("userId", "matchId", "name");

-- AddForeignKey
ALTER TABLE "MatchMember" ADD CONSTRAINT "MatchMember_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMember" ADD CONSTRAINT "MatchMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchTeam" ADD CONSTRAINT "MatchTeam_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchTeam" ADD CONSTRAINT "MatchTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRosterEntry" ADD CONSTRAINT "MatchRosterEntry_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRosterEntry" ADD CONSTRAINT "MatchRosterEntry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRosterEntry" ADD CONSTRAINT "MatchRosterEntry_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchSet" ADD CONSTRAINT "MatchSet_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtSideAssignment" ADD CONSTRAINT "CourtSideAssignment_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MatchSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtSideAssignment" ADD CONSTRAINT "CourtSideAssignment_leftTeamId_fkey" FOREIGN KEY ("leftTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtSideAssignment" ADD CONSTRAINT "CourtSideAssignment_rightTeamId_fkey" FOREIGN KEY ("rightTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureEpoch" ADD CONSTRAINT "CaptureEpoch_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrProgram" ADD CONSTRAINT "DvrProgram_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_dvrProgramId_fkey" FOREIGN KEY ("dvrProgramId") REFERENCES "DvrProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_captureEpochId_fkey" FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_initAssetId_fkey" FOREIGN KEY ("initAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_sampleIndexAssetId_fkey" FOREIGN KEY ("sampleIndexAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MatchSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_dvrProgramId_fkey" FOREIGN KEY ("dvrProgramId") REFERENCES "DvrProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_sideAssignmentId_fkey" FOREIGN KEY ("sideAssignmentId") REFERENCES "CourtSideAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_scoringTeamId_fkey" FOREIGN KEY ("scoringTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rally" ADD CONSTRAINT "Rally_activeSubmissionId_fkey" FOREIGN KEY ("activeSubmissionId") REFERENCES "RallySubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyPoint" ADD CONSTRAINT "KeyPoint_rallyId_fkey" FOREIGN KEY ("rallyId") REFERENCES "Rally"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyPoint" ADD CONSTRAINT "KeyPoint_captureEpochId_fkey" FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyPoint" ADD CONSTRAINT "KeyPoint_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyPoint" ADD CONSTRAINT "KeyPoint_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyPoint" ADD CONSTRAINT "KeyPoint_deviceSessionId_fkey" FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnotationOperation" ADD CONSTRAINT "AnnotationOperation_rallyId_fkey" FOREIGN KEY ("rallyId") REFERENCES "Rally"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnotationOperation" ADD CONSTRAINT "AnnotationOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnotationOperation" ADD CONSTRAINT "AnnotationOperation_deviceSessionId_fkey" FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_rallyId_fkey" FOREIGN KEY ("rallyId") REFERENCES "Rally"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_scoringTeamId_fkey" FOREIGN KEY ("scoringTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_leftTeamId_fkey" FOREIGN KEY ("leftTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_rightTeamId_fkey" FOREIGN KEY ("rightTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_sideAssignmentId_fkey" FOREIGN KEY ("sideAssignmentId") REFERENCES "CourtSideAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_supersedesSubmissionId_fkey" FOREIGN KEY ("supersedesSubmissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_serviceKeyPointId_fkey" FOREIGN KEY ("serviceKeyPointId") REFERENCES "RallySubmissionKeyPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_terminalKeyPointId_fkey" FOREIGN KEY ("terminalKeyPointId") REFERENCES "RallySubmissionKeyPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmissionKeyPoint" ADD CONSTRAINT "RallySubmissionKeyPoint_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RallySubmissionKeyPoint" ADD CONSTRAINT "RallySubmissionKeyPoint_captureEpochId_fkey" FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointAward" ADD CONSTRAINT "PointAward_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointAward" ADD CONSTRAINT "PointAward_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MatchSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointAward" ADD CONSTRAINT "PointAward_scoringTeamId_fkey" FOREIGN KEY ("scoringTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_clipAssetId_fkey" FOREIGN KEY ("clipAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_timingManifestAssetId_fkey" FOREIGN KEY ("timingManifestAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipKeyPointMapping" ADD CONSTRAINT "ClipKeyPointMapping_clipJobId_fkey" FOREIGN KEY ("clipJobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipKeyPointMapping" ADD CONSTRAINT "ClipKeyPointMapping_submissionKeyPointId_fkey" FOREIGN KEY ("submissionKeyPointId") REFERENCES "RallySubmissionKeyPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "AiIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_clipJobId_fkey" FOREIGN KEY ("clipJobId") REFERENCES "ClipJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallbackReceipt" ADD CONSTRAINT "AiCallbackReceipt_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_rawAnalysisAssetId_fkey" FOREIGN KEY ("rawAnalysisAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_rawOverlayAssetId_fkey" FOREIGN KEY ("rawOverlayAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisArtifact" ADD CONSTRAINT "AnalysisArtifact_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisArtifact" ADD CONSTRAINT "AnalysisArtifact_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisTrack" ADD CONSTRAINT "AnalysisTrack_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_keyPointId_fkey" FOREIGN KEY ("keyPointId") REFERENCES "RallySubmissionKeyPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEventActor" ADD CONSTRAINT "ContactEventActor_analysisRunId_keyPointId_fkey" FOREIGN KEY ("analysisRunId", "keyPointId") REFERENCES "ContactEvent"("analysisRunId", "keyPointId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEventActor" ADD CONSTRAINT "ContactEventActor_analysisRunId_trackId_fkey" FOREIGN KEY ("analysisRunId", "trackId") REFERENCES "AnalysisTrack"("analysisRunId", "trackId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEventCandidate" ADD CONSTRAINT "ContactEventCandidate_analysisRunId_keyPointId_fkey" FOREIGN KEY ("analysisRunId", "keyPointId") REFERENCES "ContactEvent"("analysisRunId", "keyPointId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEventCandidate" ADD CONSTRAINT "ContactEventCandidate_analysisRunId_trackId_fkey" FOREIGN KEY ("analysisRunId", "trackId") REFERENCES "AnalysisTrack"("analysisRunId", "trackId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEventPosition" ADD CONSTRAINT "ContactEventPosition_analysisRunId_keyPointId_fkey" FOREIGN KEY ("analysisRunId", "keyPointId") REFERENCES "ContactEvent"("analysisRunId", "keyPointId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallPathSegment" ADD CONSTRAINT "BallPathSegment_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallPathSegmentPosition" ADD CONSTRAINT "BallPathSegmentPosition_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "BallPathSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackIdentityAssignment" ADD CONSTRAINT "TrackIdentityAssignment_analysisRunId_trackId_fkey" FOREIGN KEY ("analysisRunId", "trackId") REFERENCES "AnalysisTrack"("analysisRunId", "trackId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackIdentityAssignment" ADD CONSTRAINT "TrackIdentityAssignment_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackIdentityAssignment" ADD CONSTRAINT "TrackIdentityAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAnalysisView" ADD CONSTRAINT "SavedAnalysisView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAnalysisView" ADD CONSTRAINT "SavedAnalysisView_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
