import {
  parseAnnotationCommand,
  parseAnnotationCommandResponse,
} from '@volleyball-monitoring/contracts'
import { db } from '@volleyball-monitoring/db'
import { GraphQLError } from 'graphql'
import type { AnnotationCommandService } from '../services/annotation-command.js'
import {
  cancelCorrectionDraft,
  CorrectionDraftError,
  createCorrectionDraft,
} from '../services/correction-draft.js'
import {
  cancelProcessingRally,
  ProcessingCancellationError,
} from '../services/processing-rally-cancellation.js'
import { createMediaObjectRemoverFromEnv } from '../media/media-object-remover.js'
import {
  deleteRallyWithMedia,
  updateRallyDisplayPlacement,
} from '../services/rally-administration.js'
import { builder } from './builder.js'
import { UpdateRallyPlacementInputType } from './inputs.js'
import { RallyDeleteReceiptType, RallyPlacementType, RallyType } from './types.js'

let service: AnnotationCommandService | null = null
let notifyMatchChanged:
  ((matchId: string, reason: 'rally_deleted' | 'rally_placement_updated') => void) | undefined
const mediaObjectRemover = createMediaObjectRemoverFromEnv()

export function configureAnnotationGraphQL(
  commandService: AnnotationCommandService,
  matchChanged?: (matchId: string, reason: 'rally_deleted' | 'rally_placement_updated') => void,
): void {
  service = commandService
  notifyMatchChanged = matchChanged
}

builder.mutationField('applyAnnotationCommand', t =>
  t.field({
    args: { command: t.arg({ required: true, type: 'JSON' }) },
    resolve: async (_root, args, context) => {
      if (!service) {
        throw new GraphQLError('Annotation service is unavailable', {
          extensions: { code: 'SERVICE_UNAVAILABLE' },
        })
      }
      if (!context.user || !context.deviceSessionId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      let command
      try {
        command = parseAnnotationCommand(args.command)
      } catch {
        throw new GraphQLError('Invalid annotation command', {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }
      return parseAnnotationCommandResponse(
        await service.apply(command, {
          deviceSessionId: context.deviceSessionId,
          role: context.user.role,
          userId: context.user.id,
        }),
      )
    },
    type: 'JSON',
  }),
)

builder.mutationField('createCorrectionDraft', t =>
  t.field({
    args: {
      preserveAnalysisContacts: t.arg.boolean({ required: false, defaultValue: false }),
      regenerateAnalysisContacts: t.arg.boolean({ required: false, defaultValue: false }),
      reverseCourtSides: t.arg.boolean({ required: false, defaultValue: false }),
      submissionId: t.arg.id({ required: true }),
    },
    resolve: async (_root, args, context) => {
      if (!context.user || !context.deviceSessionId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      try {
        const result = await createCorrectionDraft(
          db,
          args.submissionId,
          {
            deviceSessionId: context.deviceSessionId,
            role: context.user.role,
            userId: context.user.id,
          },
          {
            preserveAnalysisContacts: args.preserveAnalysisContacts ?? false,
            regenerateAnalysisContacts: args.regenerateAnalysisContacts ?? false,
            reverseCourtSides: args.reverseCourtSides ?? false,
            ...(context.timingManifestReader
              ? { timingManifestReader: context.timingManifestReader }
              : {}),
          },
        )
        return db.rally.findUniqueOrThrow({ where: { id: result.rally_id } })
      } catch (error) {
        if (!(error instanceof CorrectionDraftError)) throw error
        const code =
          error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'FORBIDDEN'
              ? 'FORBIDDEN'
              : error.code === 'UNAUTHENTICATED'
                ? 'UNAUTHENTICATED'
                : 'BAD_USER_INPUT'
        throw new GraphQLError(error.message, { extensions: { code, domainCode: error.code } })
      }
    },
    type: RallyType,
  }),
)

builder.mutationField('cancelCorrectionDraft', t =>
  t.field({
    args: { rallyId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.user || !context.deviceSessionId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      try {
        const result = await cancelCorrectionDraft(db, args.rallyId, {
          deviceSessionId: context.deviceSessionId,
          role: context.user.role,
          userId: context.user.id,
        })
        return db.rally.findUniqueOrThrow({ where: { id: result.rally_id } })
      } catch (error) {
        if (!(error instanceof CorrectionDraftError)) throw error
        const code =
          error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'FORBIDDEN'
              ? 'FORBIDDEN'
              : error.code === 'UNAUTHENTICATED'
                ? 'UNAUTHENTICATED'
                : 'BAD_USER_INPUT'
        throw new GraphQLError(error.message, { extensions: { code, domainCode: error.code } })
      }
    },
    type: RallyType,
  }),
)

builder.mutationField('deleteProcessingRally', t =>
  t.field({
    args: { rallyId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.user || !context.deviceSessionId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      try {
        const result = await cancelProcessingRally(db, args.rallyId, {
          deviceSessionId: context.deviceSessionId,
          role: context.user.role,
          userId: context.user.id,
        })
        return db.rally.findUniqueOrThrow({ where: { id: result.rally_id } })
      } catch (error) {
        if (!(error instanceof ProcessingCancellationError)) throw error
        const code =
          error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'FORBIDDEN'
              ? 'FORBIDDEN'
              : error.code === 'UNAUTHENTICATED'
                ? 'UNAUTHENTICATED'
                : error.code === 'SCORE_CONFLICT'
                  ? 'CONFLICT'
                  : 'BAD_USER_INPUT'
        throw new GraphQLError(error.message, { extensions: { code, domainCode: error.code } })
      }
    },
    type: RallyType,
  }),
)

builder.mutationField('deleteRally', t =>
  t.field({
    args: { rallyId: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => {
      if (!context.user) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      return deleteRallyWithMedia(context.user, args.rallyId, {
        database: db,
        ...(mediaObjectRemover ? { objectRemover: mediaObjectRemover } : {}),
        ...(notifyMatchChanged ? { notifyMatchChanged } : {}),
      })
    },
    type: RallyDeleteReceiptType,
  }),
)

builder.mutationField('updateRallyPlacement', t =>
  t.field({
    args: { input: t.arg({ required: true, type: UpdateRallyPlacementInputType }) },
    resolve: (_root, args, context) => {
      if (!context.user) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED' },
        })
      }
      return updateRallyDisplayPlacement(context.user, args.input, {
        database: db,
        ...(notifyMatchChanged ? { notifyMatchChanged } : {}),
      })
    },
    type: RallyPlacementType,
  }),
)
