import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(resolve(root, 'prisma/migrations/20260807120000_playback_windows/migration.sql'), 'utf8')
const annotationMigration = readFileSync(resolve(root, 'prisma/migrations/20260807180000_annotation_command_receipts/migration.sql'), 'utf8')

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

describe('durable annotation receipt contract', () => {
  it('keeps server sequence independent from rally revision and retains exact request/response JSON', () => {
    expect(schema).toMatch(/model AnnotationCommandReceipt \{[\s\S]*serverSequence\s+BigInt\s+@id @default\(autoincrement\(\)\)[\s\S]*commandId\s+String\s+@unique[\s\S]*rallyId\s+String\s+@db\.Uuid[\s\S]*requestHash\s+String[\s\S]*requestJson\s+Json[\s\S]*accepted\s+Boolean[\s\S]*responseJson\s+Json/)
    expect(schema).toMatch(/model AnnotationOperation \{[\s\S]*receiptServerSequence\s+BigInt\?\s+@unique[\s\S]*receipt\s+AnnotationCommandReceipt\?/)
    expect(annotationMigration).toContain('"serverSequence" BIGSERIAL NOT NULL')
    expect(annotationMigration).toContain('"commandId" TEXT NOT NULL')
    expect(annotationMigration).toContain('"requestJson" JSONB NOT NULL')
    expect(annotationMigration).toContain('"responseJson" JSONB NOT NULL')
    expect(annotationMigration).not.toContain('FOREIGN KEY ("rallyId")')
    expect(annotationMigration).not.toContain('ALTER COLUMN "receiptServerSequence" SET NOT NULL')
  })
})
