import {
  createMatchSetup,
  swapCourtSides,
  updateMatchRoster,
  updateMatchClipPolicy,
  startNextSet,
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
} from './inputs.js'
import { CaptureSessionType, MatchSetType, MatchType, ProcessingStateType } from './types.js'
import { createMediaSourceGatewayFromEnv } from '../media/media-source-gateway.js'

const mediaSourceGateway = createMediaSourceGatewayFromEnv()

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
        if (mediaSourceGateway && ['youtube', 'local_mp4'].includes(stopped.sourceKind)) {
          await mediaSourceGateway.stop(stopped.id).catch(() => undefined)
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
