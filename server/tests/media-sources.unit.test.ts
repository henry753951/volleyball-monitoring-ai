import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mediaSourceRoutes } from '../src/routes/media-sources.js'
import type {
  failCaptureStartup,
  requestCaptureCompletion,
  startCapture,
  updateCaptureSourceMetadata,
} from '../src/services/capture-processing.js'

const matchId = '10000000-0000-4000-8000-000000000001'
const captureId = '10000000-0000-4000-8000-000000000002'

function capture(input: { ingestPath: string; sourceKind: string; sourceLabel: string }) {
  return {
    health: 'HEALTHY', id: captureId, ingestPath: input.ingestPath, matchId,
    sourceKind: input.sourceKind, sourceLabel: input.sourceLabel, status: 'STARTING',
  }
}

describe('match media source routes', () => {
  it('accepts authenticated source classification and sealed completion watermarks', async () => {
    const token = 'x'.repeat(32)
    const classify = vi.fn(async () => undefined)
    const complete = vi.fn(async () => undefined)
    const fail = vi.fn(async () => undefined)
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(mediaSourceRoutes({
      authenticate: async () => null,
      callbackToken: token,
      database: {} as PrismaClient,
      failCaptureStartup: fail as unknown as typeof failCaptureStartup,
      gateway: { start: vi.fn(), stop: vi.fn() },
      importRoot: 'C:/tmp/vollyai-media-source-test',
      requestCaptureCompletion: complete as unknown as typeof requestCaptureCompletion,
      updateCaptureSourceMetadata: classify as unknown as typeof updateCaptureSourceMetadata,
    }))
    try {
      const classified = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: {
          capture_session_id: captureId,
          source_duration_us: '9055000000',
          source_kind: 'youtube_vod',
          status: 'classified',
        },
        url: '/internal/media-sources/status',
      })
      expect(classified.statusCode).toBe(204)
      expect(classify).toHaveBeenCalledWith(expect.anything(), captureId, {
        sourceDurationUs: 9_055_000_000n,
        sourceKind: 'youtube_vod',
      })

      const completed = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: {
          capture_session_id: captureId,
          expected_segment_count: 507,
          source_duration_us: '9055000000',
          source_kind: 'youtube_live',
          status: 'completed',
        },
        url: '/internal/media-sources/status',
      })
      expect(completed.statusCode).toBe(204)
      expect(complete).toHaveBeenCalledWith(expect.anything(), captureId, {
        expectedSegments: 507,
        sourceDurationUs: 9_055_000_000n,
        sourceKind: 'youtube_live',
      })
      expect(fail).not.toHaveBeenCalled()
    }
    finally { await app.close() }
  })

  it('rejects unauthenticated or mutable completion watermarks at the callback boundary', async () => {
    const token = 'y'.repeat(32)
    const complete = vi.fn(async () => undefined)
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(mediaSourceRoutes({
      authenticate: async () => null,
      callbackToken: token,
      database: {} as PrismaClient,
      gateway: { start: vi.fn(), stop: vi.fn() },
      importRoot: 'C:/tmp/vollyai-media-source-test',
      requestCaptureCompletion: complete as unknown as typeof requestCaptureCompletion,
    }))
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        payload: { capture_session_id: captureId, error_code: 'UPSTREAM', status: 'failed' },
        url: '/internal/media-sources/status',
      })
      expect(unauthenticated.statusCode).toBe(401)
      const invalid = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: {
          capture_session_id: captureId,
          expected_segment_count: -1,
          source_duration_us: null,
          source_kind: 'youtube_live',
          status: 'completed',
        },
        url: '/internal/media-sources/status',
      })
      expect(invalid.statusCode).toBe(400)
      expect(complete).not.toHaveBeenCalled()
    }
    finally { await app.close() }
  })

  it('creates a match-scoped opaque YouTube capture and delegates ingest', async () => {
    const gateway = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
    const createCapture = vi.fn(async (_db, _identity, input) => capture(input))
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(mediaSourceRoutes({
      authenticate: async () => ({ userId: 'operator-1', deviceSessionId: 'test-session', role: UserRole.OPERATOR }),
      database: {} as PrismaClient,
      gateway,
      importRoot: 'C:/tmp/vollyai-media-source-test',
      startCapture: createCapture as unknown as typeof startCapture,
    }))
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { match_id: matchId, source_label: '主場', source_url: 'https://www.youtube.com/watch?v=NMTbgYfa-ZM#fragment' },
        url: '/api/v1/media-sources/youtube',
      })
      expect(response.statusCode).toBe(202)
      expect(createCapture).toHaveBeenCalledOnce()
      const captureInput = createCapture.mock.calls[0]![2]
      expect(captureInput.ingestPath).toMatch(new RegExp(`^youtube-${matchId}-[0-9a-f-]{36}$`))
      expect(captureInput.sourceConfigSecretRef).toMatch(/^media-source:\/\/youtube\/youtube-[0-9a-f-]+$/)
      expect(JSON.stringify(captureInput)).not.toContain('NMTbgYfa-ZM')
      expect(gateway.start).toHaveBeenCalledWith(expect.objectContaining({
        captureSessionId: captureId,
        sourceKind: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=NMTbgYfa-ZM',
      }))
    }
    finally { await app.close() }
  })

  it('rejects non-YouTube hosts before creating a capture', async () => {
    const createCapture = vi.fn()
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(mediaSourceRoutes({
      authenticate: async () => ({ userId: 'operator-1', deviceSessionId: 'test-session', role: UserRole.OPERATOR }),
      database: {} as PrismaClient,
      gateway: { start: vi.fn(), stop: vi.fn() },
      importRoot: 'C:/tmp/vollyai-media-source-test',
      startCapture: createCapture as unknown as typeof startCapture,
    }))
    try {
      const response = await app.inject({ method: 'POST', payload: { match_id: matchId, source_url: 'https://example.com/watch?v=x' }, url: '/api/v1/media-sources/youtube' })
      expect(response.statusCode).toBe(400)
      expect(createCapture).not.toHaveBeenCalled()
    }
    finally { await app.close() }
  })

  it('passes a shared-root-relative import key to the local media gateway', async () => {
    const importRoot = await mkdtemp(join(tmpdir(), 'vollyai-media-upload-'))
    const gateway = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
    const createCapture = vi.fn(async (_db, _identity, input) => capture(input))
    const app = Fastify({ logger: false })
    await app.register(multipart)
    await app.register(mediaSourceRoutes({
      authenticate: async () => ({ userId: 'operator-1', deviceSessionId: 'test-session', role: UserRole.OPERATOR }),
      database: {} as PrismaClient,
      gateway,
      importRoot,
      startCapture: createCapture as unknown as typeof startCapture,
    }))
    const boundary = '----vollyai-local-upload-boundary'
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="match_id"\r\n\r\n${matchId}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="source_label"\r\n\r\nLocal QA\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.mp4"\r\nContent-Type: video/mp4\r\n\r\nvideo-bytes\r\n`,
      `--${boundary}--\r\n`,
    ].join('')
    try {
      const response = await app.inject({
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        method: 'POST',
        payload: Buffer.from(payload),
        url: '/api/v1/media-sources/upload',
      })
      expect(response.statusCode).toBe(202)
      expect(gateway.start).toHaveBeenCalledWith(expect.objectContaining({
        captureSessionId: captureId,
        importPath: `${captureId}/source.mp4`,
        sourceKind: 'local_mp4',
      }))
    }
    finally {
      await app.close()
      await rm(importRoot, { force: true, recursive: true })
    }
  })
})
