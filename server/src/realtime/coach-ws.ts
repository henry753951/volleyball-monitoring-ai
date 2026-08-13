import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

interface CoachSocketIdentity {
  userId: string
}

interface CoachWebSocketDependencies {
  authenticate(request: FastifyRequest): Promise<CoachSocketIdentity | null>
  events?: CoachMatchEventHub
}

export interface CoachMatchInvalidation {
  type: 'match_state_invalidated'
  match_id: string
  reason: 'analysis_review_updated' | 'analysis_state_updated' | 'identity_mapping_updated' | 'rally_deleted' | 'rally_placement_updated'
  server_time_ms: number
}

export class CoachMatchEventHub {
  private readonly listeners = new Set<(event: CoachMatchInvalidation) => void>()

  publish(matchId: string, reason: CoachMatchInvalidation['reason']): void {
    const event: CoachMatchInvalidation = {
      match_id: matchId,
      reason,
      server_time_ms: Date.now(),
      type: 'match_state_invalidated',
    }
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: (event: CoachMatchInvalidation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

interface PingMessage {
  type: 'ping'
  client_time_ms: number
}

function parsePing(value: unknown): PingMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type !== 'ping' || typeof message.client_time_ms !== 'number' || !Number.isFinite(message.client_time_ms)) return null
  return { type: 'ping', client_time_ms: message.client_time_ms }
}

export const coachWebSocketRoutes = (
  deps: CoachWebSocketDependencies,
): FastifyPluginAsync => async (app) => {
  app.get('/ws/coach', { websocket: true }, (socket, request) => {
    void (async () => {
      let identity: CoachSocketIdentity | null
      try { identity = await deps.authenticate(request) }
      catch { socket.close(1008, 'authentication failed'); return }
      if (!identity) { socket.close(1008, 'authentication required'); return }

      socket.send(JSON.stringify({ type: 'ready', server_time_ms: Date.now() }))
      const unsubscribe = deps.events?.subscribe((event) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(event))
      })
      socket.on('close', () => unsubscribe?.())
      socket.on('message', (raw) => {
        let value: unknown
        try { value = JSON.parse(raw.toString()) }
        catch { socket.close(1003, 'invalid coach message'); return }
        const ping = parsePing(value)
        if (!ping) { socket.close(1003, 'unsupported coach message'); return }
        socket.send(JSON.stringify({
          type: 'pong',
          client_time_ms: ping.client_time_ms,
          server_time_ms: Date.now(),
        }))
      })
    })()
  })
}
