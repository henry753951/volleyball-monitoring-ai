import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(resolve(root, 'prisma/migrations/20260807120000_playback_windows/migration.sql'), 'utf8')

describe('playback window persistence contract', () => {
  it('declares enum, models, relations and exact scalar choices', () => {
    expect(schema).toContain('enum PlaybackWindowMode')
    expect(schema).toMatch(/model PlaybackWindow \{[\s\S]*mappingVersion\s+Int[\s\S]*timelineVersion\s+BigInt[\s\S]*captureStartUs\s+BigInt[\s\S]*targetPlayerMediaTimeUs\s+BigInt/)
    expect(schema).toMatch(/model PlaybackWindowSegment \{[\s\S]*sequenceIndex\s+Int[\s\S]*playbackWindow\s+PlaybackWindow[\s\S]*dvrSegment\s+DvrSegment/)
    expect(schema).toContain('internalSchemaVersion  String?')
    expect(schema).toContain('@@unique([playbackWindowId, sequenceIndex])')
    expect(schema).toContain('@@unique([playbackWindowId, dvrSegmentId])')
    expect(schema).toContain('@@index([captureSessionId, expiresAt])')
    expect(schema).toContain('@@index([dvrProgramId, captureStartUs, captureEndUs])')
  })

  it('contains every named migration check constraint', () => {
    for (const name of ['DvrSegment_capture_range_check', 'DvrSegment_nonnegative_check', 'PlaybackWindow_capture_range_check', 'PlaybackWindow_origin_check', 'PlaybackWindow_target_check', 'PlaybackWindow_mapping_check', 'PlaybackWindow_target_within_mapping_check', 'PlaybackWindowSegment_sequence_check']) expect(migration).toContain(name)
  })
})
