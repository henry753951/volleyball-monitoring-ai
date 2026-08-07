import {
  parseAnnotationCommand,
  parseAnnotationServerMessage,
} from '@volleyball-monitoring/contracts'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type {
  AnnotationCommandService,
  AnnotationIdentity,
} from '../services/annotation-command.js'

export interface AnnotationWebSocketDependencies {
  authenticate: (request: FastifyRequest) => Promise<AnnotationIdentity | null>
  service: AnnotationCommandService
}

export const annotationWebSocketRoutes = (
  deps: AnnotationWebSocketDependencies,
): FastifyPluginAsync => async (app) => {
  app.get<{ Querystring: { room_id?: string } }>(
    '/ws/annotations',
    { websocket: true },
    (socket, request) => {
      void (async () => {
        const roomId = request.query.room_id
        if (!roomId) {
          socket.close(1008, 'room_id is required')
          return
        }
        let identity: AnnotationIdentity | null
        try {
          identity = await deps.authenticate(request)
        } catch {
          socket.close(1008, 'authentication failed')
          return
        }
        if (!identity) {
          socket.close(1008, 'authentication required')
          return
        }
        const room = await deps.service.authorizeRoom(roomId, identity)
        if (!room || room.roomId !== roomId.toLowerCase()) {
          socket.close(1008, 'annotation room not found')
          return
        }
        const ready = parseAnnotationServerMessage({
          schema_version: '2.0.0',
          type: 'connection_ready',
          authenticated_user_id: identity.userId,
          device_session_id: identity.deviceSessionId,
          room_id: room.roomId,
          server_sequence: (await deps.service.roomSequence(room.roomId)).toString(),
        })
        socket.send(JSON.stringify(ready))

        socket.on('message', (raw) => {
          void (async () => {
            let command
            try {
              command = parseAnnotationCommand(raw.toString())
            } catch {
              try {
                command = parseAnnotationCommand(JSON.parse(raw.toString()))
              } catch {
                socket.close(1003, 'invalid annotation command')
                return
              }
            }
            if (command.room_id !== room.roomId) {
              socket.close(1008, 'command room mismatch')
              return
            }
            try {
              socket.send(JSON.stringify(await deps.service.apply(command, identity)))
            } catch {
              socket.close(1011, 'annotation command failed')
            }
          })()
        })
      })()
    },
  )
}
