import { brotliDecompressSync } from 'node:zlib'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerResponseCompression } from '../src/http/response-compression.js'

describe('response compression', () => {
  it('compresses large JSON before it crosses the media tunnel', async () => {
    const app = Fastify()
    await registerResponseCompression(app)
    app.get('/snapshot', async () => ({ payload: 'x'.repeat(32 * 1_024) }))

    const response = await app.inject({
      headers: { 'accept-encoding': 'br, gzip' },
      method: 'GET',
      url: '/snapshot',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-encoding']).toBe('br')
    expect(response.rawPayload.length).toBeLessThan(1_024)
    expect(JSON.parse(brotliDecompressSync(response.rawPayload).toString())).toEqual({
      payload: 'x'.repeat(32 * 1_024),
    })
    await app.close()
  })

  it('does not compress MP4 bytes or disturb their content length', async () => {
    const app = Fastify()
    await registerResponseCompression(app)
    const bytes = Buffer.alloc(4 * 1_024, 7)
    app.get('/media', async (_request, reply) => reply.type('video/mp4').send(bytes))

    const response = await app.inject({
      headers: { 'accept-encoding': 'br, gzip' },
      method: 'GET',
      url: '/media',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.headers['content-length']).toBe(String(bytes.length))
    expect(response.rawPayload).toEqual(bytes)
    await app.close()
  })
})
