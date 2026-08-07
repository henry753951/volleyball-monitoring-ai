import { parseAnnotationCommand, parseAnnotationCommandResponse } from '@volleyball-monitoring/contracts'
import { GraphQLError } from 'graphql'
import type { AnnotationCommandService } from '../services/annotation-command.js'
import { builder } from './builder.js'

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
