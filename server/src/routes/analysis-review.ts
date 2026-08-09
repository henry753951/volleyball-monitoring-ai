import { parseAnalysisReviewPatch, type AnalysisReviewRevisionEvent } from '@volleyball-monitoring/contracts'
import { db } from '@volleyball-monitoring/db'
import type { FastifyPluginAsync } from 'fastify'
import { authenticateDevelopmentAnnotationRequest } from '../realtime/auth.js'
import { AnalysisReviewError, applyAnalysisReviewPatch, canReadAnalysisReview, readAnalysisReview } from '../services/analysis-review.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
type ReviewSocket = { readyState: number; send: (payload: string) => void }
const sockets = new Map<string, Set<ReviewSocket>>()

function broadcast(analysisRunId: string, revision: string) {
  const message: AnalysisReviewRevisionEvent = { schema_version: '1.0.0', type: 'analysis_review_revision', analysis_run_id: analysisRunId, revision }
  const payload = JSON.stringify(message)
  for (const socket of sockets.get(analysisRunId) ?? []) if (socket.readyState === 1) socket.send(payload)
}

export const analysisReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { analysisRunId: string }; Querystring: { after_revision?: string } }>('/api/v1/analysis-runs/:analysisRunId/review', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId) || (request.query.after_revision !== undefined && !/^(0|[1-9][0-9]*)$/.test(request.query.after_revision))) return reply.status(400).send({ code: 'BAD_REQUEST' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const state = await readAnalysisReview(db, { analysisRunId: request.params.analysisRunId, ...(request.query.after_revision === undefined ? {} : { afterRevision: BigInt(request.query.after_revision) }), identity })
    return state ? reply.header('Cache-Control', 'private, no-store').send(state) : reply.status(404).send({ code: 'NOT_FOUND' })
  })

  app.patch<{ Params: { analysisRunId: string } }>('/api/v1/analysis-runs/:analysisRunId/review', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId)) return reply.status(400).send({ code: 'BAD_REQUEST' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    try {
      const result = await applyAnalysisReviewPatch(db, { analysisRunId: request.params.analysisRunId, patch: parseAnalysisReviewPatch(request.body), identity })
      broadcast(request.params.analysisRunId, result.revision)
      return reply.header('Cache-Control', 'private, no-store').send(result)
    }
    catch (error) {
      if (error instanceof TypeError) return reply.status(400).send({ code: 'BAD_REQUEST', message: error.message })
      if (error instanceof AnalysisReviewError) return reply.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).send({ code: error.code, message: error.message })
      throw error
    }
  })

  app.get<{ Params: { analysisRunId: string } }>('/ws/analysis-reviews/:analysisRunId', { websocket: true }, (socket, request) => {
    void (async () => {
      const analysisRunId = request.params.analysisRunId
      if (!UUID.test(analysisRunId)) return socket.close(1008, 'invalid analysis run')
      const identity = await authenticateDevelopmentAnnotationRequest(request, db).catch(() => null)
      if (!identity || !(await canReadAnalysisReview(db, analysisRunId, identity))) return socket.close(1008, 'analysis review unavailable')
      const peers = sockets.get(analysisRunId) ?? new Set<ReviewSocket>()
      peers.add(socket)
      sockets.set(analysisRunId, peers)
      socket.on('close', () => { peers.delete(socket); if (!peers.size) sockets.delete(analysisRunId) })
      const state = await readAnalysisReview(db, { analysisRunId, identity })
      if (state && socket.readyState === 1) broadcast(analysisRunId, state.revision)
    })()
  })
}
