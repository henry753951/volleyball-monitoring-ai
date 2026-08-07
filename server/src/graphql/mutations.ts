import {
  createMatchSetup,
  swapCourtSides,
} from '../services/core-domain.js'
import { builder } from './builder.js'
import { requireIdentity } from './errors.js'
import {
  CreateMatchSetupInputType,
  SwapCourtSidesInputType,
} from './inputs.js'
import { MatchSetType, MatchType } from './types.js'

builder.mutationType({
  fields: (t) => ({
    createMatchSetup: t.field({
      args: { input: t.arg({ required: true, type: CreateMatchSetupInputType }) },
      resolve: (_root, args, context) => createMatchSetup(requireIdentity(context), args.input),
      type: MatchType,
    }),
    swapCourtSides: t.field({
      args: { input: t.arg({ required: true, type: SwapCourtSidesInputType }) },
      resolve: (_root, args, context) => swapCourtSides(requireIdentity(context), args.input),
      type: MatchSetType,
    }),
  }),
})
