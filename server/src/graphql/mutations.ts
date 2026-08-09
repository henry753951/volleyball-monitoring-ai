import {
  createMatchSetup,
  swapCourtSides,
  updateMatchRoster,
  updateMatchClipPolicy,
  startNextSet,
  updateMatch,
} from '../services/core-domain.js'
import { db } from '@volleyball-monitoring/db'
import {
  OperationalMutationError,
  retryProcessing,
  startCapture,
  stopCapture,
} from '../services/capture-processing.js'
import { builder } from './builder.js'
import { domainError, requireIdentity } from './errors.js'
import {
  CreateMatchSetupInputType,
  RetryProcessingInputType,
  StartCaptureInputType,
  SwapCourtSidesInputType,
  UpdateMatchRosterInputType,
  UpdateMatchClipPolicyInputType,
  StartNextSetInputType,
  UpdateMatchInputType,
} from './inputs.js'
import { CaptureSessionType, MatchDeleteReceiptType, MatchSetType, MatchType, ProcessingStateType } from './types.js'
import { createMediaSourceGatewayFromEnv } from '../media/media-source-gateway.js'
import { createMediaObjectRemoverFromEnv } from '../media/media-object-remover.js'
import { deleteMatchWithMedia } from '../services/match-administration.js'

const mediaSourceGateway = createMediaSourceGatewayFromEnv()
const mediaObjectRemover = createMediaObjectRemoverFromEnv()

async function operational<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    if (!(error instanceof OperationalMutationError)) throw error
    const code = error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'FORBIDDEN'
        ? 'FORBIDDEN'
        : 'BAD_USER_INPUT'
    return domainError(error.message, code)
  }
}

builder.mutationType({
  fields: (t) => ({
    createMatchSetup: t.field({
      args: { input: t.arg({ required: true, type: CreateMatchSetupInputType }) },
      resolve: (_root, args, context) => createMatchSetup(requireIdentity(context), args.input),
      type: MatchType,
    }),
    deleteMatch: t.field({
      args: { matchId: t.arg.id({ required: true }) },
      resolve: (_root, args, context) => deleteMatchWithMedia(requireIdentity(context), args.matchId, {
        database: db,
        importRoot: process.env.MEDIA_IMPORT_ROOT ?? '/var/lib/volleyball/media-imports',
        ...(mediaSourceGateway ? { mediaSourceGateway } : {}),
        ...(mediaObjectRemover ? { objectRemover: mediaObjectRemover } : {}),
        recordingRoot: process.env.MEDIA_RECORDING_ROOT ?? '/var/lib/volleyball/media-recordings',
      }),
      type: MatchDeleteReceiptType,
    }),
    retryProcessing: t.field({
      args: { input: t.arg({ required: true, type: RetryProcessingInputType }) },
      resolve: (_root, args, context) => {
        const identity = requireIdentity(context)
        return operational(() => retryProcessing(
          db,
          identity,
          args.input.rallyId,
          process.env.AI_CALLBACK_TOKEN_SECRET ?? '',
        ))
      },
      type: ProcessingStateType,
    }),
    startCapture: t.field({
      args: { input: t.arg({ required: true, type: StartCaptureInputType }) },
      resolve: (_root, args, context) => operational(() => startCapture(db, requireIdentity(context), args.input)),
      type: CaptureSessionType,
    }),
    stopCapture: t.field({
      args: { captureSessionId: t.arg.id({ required: true }) },
      resolve: async (_root, args, context) => {
        const stopped = await operational(() => stopCapture(db, requireIdentity(context), args.captureSessionId))
        if (mediaSourceGateway && ['youtube', 'youtube_live', 'youtube_vod', 'local_mp4'].includes(stopped.sourceKind)) {
          await mediaSourceGateway.stop(stopped.id)
        }
        return stopped
      },
      type: CaptureSessionType,
    }),
    swapCourtSides: t.field({
      args: { input: t.arg({ required: true, type: SwapCourtSidesInputType }) },
      resolve: (_root, args, context) => swapCourtSides(requireIdentity(context), args.input),
      type: MatchSetType,
    }),
    updateMatchRoster: t.field({
      args: { input: t.arg({ required: true, type: UpdateMatchRosterInputType }) },
      resolve: (_root, args, context) => updateMatchRoster(requireIdentity(context), args.input),
      type: MatchType,
    }),
    updateMatch: t.field({
      args: { input: t.arg({ required: true, type: UpdateMatchInputType }) },
      resolve: (_root, args, context) => updateMatch(requireIdentity(context), args.input),
      type: MatchType,
    }),
    updateMatchClipPolicy: t.field({
      args: { input: t.arg({ required: true, type: UpdateMatchClipPolicyInputType }) },
      resolve: (_root, args, context) => updateMatchClipPolicy(requireIdentity(context), args.input),
      type: MatchType,
    }),
    startNextSet: t.field({
      args: { input: t.arg({ required: true, type: StartNextSetInputType }) },
      resolve: (_root, args, context) => startNextSet(requireIdentity(context), args.input),
      type: MatchSetType,
    }),
  }),
})
