import { builder } from './builder.js'
import type {
  CreateMatchSetupInput,
  RosterEditInput,
  RosterSetupInput,
  SwapCourtSidesInput,
  TeamSetupInput,
  UpdateMatchRosterInput,
} from '../services/core-domain.js'
import type { StartCaptureInput } from '../services/capture-processing.js'

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

export const RosterEditInputType = builder.inputRef<RosterEditInput>('RosterEditInput')
RosterEditInputType.implement({
  fields: (t) => ({
    id: t.id(),
    jerseyNumber: t.string({ required: true }),
    name: t.string({ required: true }),
  }),
})

export const UpdateMatchRosterInputType = builder.inputRef<UpdateMatchRosterInput>('UpdateMatchRosterInput')
UpdateMatchRosterInputType.implement({
  fields: (t) => ({
    matchId: t.id({ required: true }),
    roster: t.field({ required: true, type: [RosterEditInputType] }),
    teamId: t.id({ required: true }),
  }),
})

export const StartCaptureInputType = builder.inputRef<StartCaptureInput>('StartCaptureInput')
StartCaptureInputType.implement({
  fields: (t) => ({
    ingestPath: t.string({ required: true }),
    matchId: t.id({ required: true }),
    sourceConfigSecretRef: t.string(),
    sourceKind: t.string({ required: true }),
    sourceLabel: t.string(),
  }),
})

export interface RetryProcessingInput {
  rallyId: string
}

export const RetryProcessingInputType = builder.inputRef<RetryProcessingInput>('RetryProcessingInput')
RetryProcessingInputType.implement({
  fields: (t) => ({ rallyId: t.id({ required: true }) }),
})
