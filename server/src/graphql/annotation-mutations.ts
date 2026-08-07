import { parseAnnotationCommand, parseAnnotationCommandResponse } from '@volleyball-monitoring/contracts'
import { db } from '@volleyball-monitoring/db'
import { GraphQLError } from 'graphql'
import type { AnnotationCommandService } from '../services/annotation-command.js'
import { CorrectionDraftError, createCorrectionDraft } from '../services/correction-draft.js'
import { builder } from './builder.js'
import { RallyType } from './types.js'

let service: AnnotationCommandService | null = null

export function configureAnnotationGraphQL(commandService: AnnotationCommandService): void {
  service = commandService
}

builder.mutationField('applyAnnotationCommand', (t) => t.field({
  args: { command: t.arg({ required: true, type: 'JSON' }) },
  resolve: async (_root, args, context) => {
    if (!service) {
      throw new GraphQLError('Annotation service is unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } })
    }
    if (!context.user || !context.deviceSessionId) {
      throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } })
    }
    let command
    try {
      command = parseAnnotationCommand(args.command)
    } catch {
      throw new GraphQLError('Invalid annotation command', { extensions: { code: 'BAD_USER_INPUT' } })
    }
    return parseAnnotationCommandResponse(await service.apply(command, {
      deviceSessionId: context.deviceSessionId,
      role: context.user.role,
      userId: context.user.id,
    }))
  },
  type: 'JSON',
}))

builder.mutationField('createCorrectionDraft', (t) => t.field({
  args: { submissionId: t.arg.id({ required: true }) },
  resolve: async (_root, args, context) => {
    if (!context.user || !context.deviceSessionId) {
      throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } })
    }
    try {
      const result = await createCorrectionDraft(db, args.submissionId, {
        deviceSessionId: context.deviceSessionId,
        role: context.user.role,
        userId: context.user.id,
      })
      return db.rally.findUniqueOrThrow({ where: { id: result.rally_id } })
    }
    catch (error) {
      if (!(error instanceof CorrectionDraftError)) throw error
      const code = error.code === 'NOT_FOUND'
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
}))
