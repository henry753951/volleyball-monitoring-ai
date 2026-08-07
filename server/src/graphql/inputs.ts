import { builder } from './builder.js'
import type {
  CreateMatchSetupInput,
  RosterSetupInput,
  SwapCourtSidesInput,
  TeamSetupInput,
} from '../services/core-domain.js'

export const RosterInputType = builder.inputRef<RosterSetupInput>('RosterInput')
RosterInputType.implement({
  fields: (t) => ({
    jerseyNumber: t.string({ required: true }),
    name: t.string({ required: true }),
  }),
})

export const TeamSetupInputType = builder.inputRef<TeamSetupInput>('TeamSetupInput')
TeamSetupInputType.implement({
  fields: (t) => ({
    name: t.string({ required: true }),
    roster: t.field({ required: true, type: [RosterInputType] }),
    shortName: t.string({ required: true }),
  }),
})

export const CreateMatchSetupInputType = builder.inputRef<CreateMatchSetupInput>('CreateMatchSetupInput')
CreateMatchSetupInputType.implement({
  fields: (t) => ({
    leftTeam: t.field({ required: true, type: TeamSetupInputType }),
    rightTeam: t.field({ required: true, type: TeamSetupInputType }),
    scheduledAt: t.field({ type: 'DateTime' }),
    title: t.string({ required: true }),
    venue: t.string(),
  }),
})

export const SwapCourtSidesInputType = builder.inputRef<SwapCourtSidesInput>('SwapCourtSidesInput')
SwapCourtSidesInputType.implement({
  fields: (t) => ({
    effectiveFromRallyOrdinal: t.int({ required: true }),
    setId: t.id({ required: true }),
  }),
})
