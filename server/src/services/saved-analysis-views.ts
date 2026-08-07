import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, type UserRole } from '@volleyball-monitoring/db/client'
import { z } from 'zod'

export const SAVED_VIEW_FILTER_SCHEMA_VERSION = '1.0.0'
export const SAVED_VIEW_OVERLAY_PRESET_VERSION = '1.0.0'

const uuid = z.string().uuid()
const filtersSchema = z.strictObject({
  set_numbers: z.array(z.number().int().positive()).max(32).optional(),
  team_ids: z.array(uuid).max(8).optional(),
  roster_entry_ids: z.array(uuid).max(64).optional(),
  score_resolution: z.array(z.enum(['resolved', 'unknown'])).max(2).optional(),
  processing_status: z.array(z.enum(['idle', 'clip_queued', 'clipping', 'ai_queued', 'ai_processing', 'artifact_ingesting', 'completed', 'failed', 'superseded'])).max(9).optional(),
  association_quality: z.array(z.enum(['resolved_single', 'resolved_multiple', 'ambiguous', 'unresolved', 'no_player'])).max(5).optional(),
  start_zones: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  target_zones: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  action_labels: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  submitted_from: z.string().datetime({ offset: true }).optional(),
  submitted_to: z.string().datetime({ offset: true }).optional(),
})
const layoutSchema = z.strictObject({
  route: z.enum(['history', 'paths', 'players', 'stats']).default('stats'),
  overlay_mode: z.enum(['off', 'tracking', 'coach', 'tactical', 'debug']).optional(),
  visible_layers: z.array(z.enum(['bbox', 'track_id', 'player', 'action', 'ball', 'trail', 'footprint', 'confidence'])).max(8).optional(),
}).nullable()

function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue }
async function authorized(database: PrismaClient, matchId: string, userId: string, role: UserRole) {
  return database.match.findFirst({ where: { id: matchId, ...(role === 'ADMIN' ? {} : { members: { some: { userId } } }) }, select: { id: true } })
}
const wire = (view: { id: string; matchId: string; name: string; filterSchemaVersion: string; overlayPresetVersion: string; filters: unknown; layout: unknown; createdAt: Date; updatedAt: Date }) => ({ id: view.id, match_id: view.matchId, name: view.name, filter_schema_version: view.filterSchemaVersion, overlay_preset_version: view.overlayPresetVersion, filters: view.filters, layout: view.layout, saved_at: view.updatedAt.toISOString(), created_at: view.createdAt.toISOString() })

export async function listSavedAnalysisViews(database: PrismaClient, input: { matchId: string; userId: string; role: UserRole }) {
  if (!await authorized(database, input.matchId, input.userId, input.role)) return null
  const views = await database.savedAnalysisView.findMany({ where: { matchId: input.matchId, userId: input.userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
  return { schema_version: '1.0.0', views: views.map(wire) }
}

export async function saveAnalysisView(database: PrismaClient, input: { matchId: string; userId: string; role: UserRole; name: string; filters: unknown; layout?: unknown }) {
  if (!await authorized(database, input.matchId, input.userId, input.role)) throw new Error('NOT_FOUND')
  const name = input.name.trim()
  if (!name || name.length > 80) throw new Error('BAD_USER_INPUT')
  const filters = filtersSchema.safeParse(input.filters)
  const layout = layoutSchema.safeParse(input.layout ?? null)
  if (!filters.success || !layout.success) throw new Error('BAD_USER_INPUT')
  if (filters.data.submitted_from && filters.data.submitted_to && Date.parse(filters.data.submitted_from) > Date.parse(filters.data.submitted_to)) throw new Error('BAD_USER_INPUT')
  const view = await database.savedAnalysisView.upsert({
    where: { userId_matchId_name: { userId: input.userId, matchId: input.matchId, name } },
    create: { userId: input.userId, matchId: input.matchId, name, filterSchemaVersion: SAVED_VIEW_FILTER_SCHEMA_VERSION, overlayPresetVersion: SAVED_VIEW_OVERLAY_PRESET_VERSION, filters: json(filters.data), layout: layout.data === null ? Prisma.JsonNull : json(layout.data) },
    update: { filterSchemaVersion: SAVED_VIEW_FILTER_SCHEMA_VERSION, overlayPresetVersion: SAVED_VIEW_OVERLAY_PRESET_VERSION, filters: json(filters.data), layout: layout.data === null ? Prisma.JsonNull : json(layout.data) },
  })
  return { schema_version: '1.0.0', view: wire(view) }
}
