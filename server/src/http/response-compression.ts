import compress from '@fastify/compress'
import type { FastifyInstance } from 'fastify'

export async function registerResponseCompression(app: FastifyInstance) {
  await app.register(compress, {
    encodings: ['br', 'gzip'],
    globalDecompression: false,
    threshold: 1_024,
  })
}
