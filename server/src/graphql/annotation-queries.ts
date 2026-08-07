import { getAnnotationSnapshot } from '../services/annotation-snapshot.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'

builder.queryField('annotationRallySnapshot', (t) => t.field({
  args: { roomId: t.arg.string({ required: true }), rallyId: t.arg.id({ required: true }) },
  nullable: true,
  type: 'JSON',
  resolve: (_root, args, context) => {
    const identity = requireIdentity(context)
    return getAnnotationSnapshot({ roomId: args.roomId, rallyId: args.rallyId, userId: identity.id, role: identity.role })
  },
}))
