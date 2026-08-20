import { builder } from './builder.js'
import type {
  CreateMatchSetupInput,
  RosterEditInput,
  RosterSetupInput,
  SwapCourtSidesInput,
  TeamSetupInput,
  UpdateMatchRosterInput,
  UpdateMatchClipPolicyInput,
  StartNextSetInput,
  ReopenLastSetInput,
  UpdateMatchInput,
} from '../services/core-domain.js'
import type { StartCaptureInput } from '../services/capture-processing.js'
import { MatchStatusType, RosterPositionType } from './types.js'

export const RosterInputType = builder.inputRef<RosterSetupInput>('RosterInput')
RosterInputType.implement({
  fields: t => ({
    jerseyNumber: t.string({ required: true }),
    name: t.string({ required: true }),
    position: t.field({ type: RosterPositionType }),
  }),
})

export const TeamSetupInputType = builder.inputRef<TeamSetupInput>('TeamSetupInput')
TeamSetupInputType.implement({
  fields: t => ({
    name: t.string({ required: true }),
    roster: t.field({ required: true, type: [RosterInputType] }),
    shortName: t.string({ required: true }),
  }),
})

export const CreateMatchSetupInputType =
  builder.inputRef<CreateMatchSetupInput>('CreateMatchSetupInput')
CreateMatchSetupInputType.implement({
  fields: t => ({
    teams: t.field({ required: true, type: [TeamSetupInputType] }),
    scheduledAt: t.field({ type: 'DateTime' }),
    title: t.string({ required: true }),
    venue: t.string(),
  }),
})

export const SwapCourtSidesInputType = builder.inputRef<SwapCourtSidesInput>('SwapCourtSidesInput')
SwapCourtSidesInputType.implement({
  fields: t => ({
    effectiveFromRallyId: t.id(),
    effectiveFromRallyOrdinal: t.int({ required: true }),
    expectedLeftTeamId: t.id({ required: true }),
    expectedRightTeamId: t.id({ required: true }),
    setId: t.id({ required: true }),
  }),
})

export const UpdateMatchInputType = builder.inputRef<UpdateMatchInput>('UpdateMatchInput')
UpdateMatchInputType.implement({
  fields: t => ({
    matchId: t.id({ required: true }),
    scheduledAt: t.field({ type: 'DateTime' }),
    status: t.field({ required: true, type: MatchStatusType }),
    title: t.string({ required: true }),
    venue: t.string(),
  }),
})

export const RosterEditInputType = builder.inputRef<RosterEditInput>('RosterEditInput')
RosterEditInputType.implement({
  fields: t => ({
    id: t.id(),
    jerseyNumber: t.string({ required: true }),
    name: t.string({ required: true }),
    position: t.field({ type: RosterPositionType }),
  }),
})

export const UpdateMatchRosterInputType =
  builder.inputRef<UpdateMatchRosterInput>('UpdateMatchRosterInput')
UpdateMatchRosterInputType.implement({
  fields: t => ({
    matchId: t.id({ required: true }),
    roster: t.field({ required: true, type: [RosterEditInputType] }),
    teamId: t.id({ required: true }),
  }),
})

export const UpdateMatchClipPolicyInputType = builder.inputRef<UpdateMatchClipPolicyInput>(
  'UpdateMatchClipPolicyInput',
)
UpdateMatchClipPolicyInputType.implement({
  fields: t => ({
    matchId: t.id({ required: true }),
    postRollSeconds: t.int({ required: true }),
    preRollSeconds: t.int({ required: true }),
  }),
})

export const StartNextSetInputType = builder.inputRef<StartNextSetInput>('StartNextSetInput')
StartNextSetInputType.implement({
  fields: t => ({
    effectiveFromRallyId: t.id(),
    matchId: t.id({ required: true }),
    winningTeamId: t.id({ required: true }),
  }),
})

export const ReopenLastSetInputType = builder.inputRef<ReopenLastSetInput>('ReopenLastSetInput')
ReopenLastSetInputType.implement({
  fields: t => ({
    matchId: t.id({ required: true }),
    setId: t.id(),
  }),
})

export const StartCaptureInputType = builder.inputRef<StartCaptureInput>('StartCaptureInput')
StartCaptureInputType.implement({
  fields: t => ({
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

export const RetryProcessingInputType =
  builder.inputRef<RetryProcessingInput>('RetryProcessingInput')
RetryProcessingInputType.implement({
  fields: t => ({ rallyId: t.id({ required: true }) }),
})

export interface UpdateRallyPlacementInput {
  rallyId: string
  setNumber: number
  ordinal: number
}

export const UpdateRallyPlacementInputType = builder.inputRef<UpdateRallyPlacementInput>(
  'UpdateRallyPlacementInput',
)
UpdateRallyPlacementInputType.implement({
  fields: t => ({
    ordinal: t.int({ required: true }),
    rallyId: t.id({ required: true }),
    setNumber: t.int({ required: true }),
  }),
})
