import { UserRole, type PrismaClient } from '@volleyball-monitoring/db/client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const ROOM = new RegExp(`^match:(${UUID}):capture:(${UUID})$`)

export interface AnnotationRoom {
  roomId: string
  matchId: string
  captureSessionId: string
}

export interface AnnotationIdentity {
  userId: string
  role: UserRole
  deviceSessionId: string
}

export function parseAnnotationRoomId(roomId: string): AnnotationRoom {
  const match = ROOM.exec(roomId)
  if (!match) {
    throw new TypeError('Invalid annotation room id')
  }
  const matchId = match[1]!
  const captureSessionId = match[2]!
  const canonical = `match:${matchId}:capture:${captureSessionId}`
  return {
    captureSessionId,
    matchId,
    roomId: canonical,
  }
}

export async function authorizeAnnotationRoom(
  database: PrismaClient,
  roomId: string,
  identity: AnnotationIdentity,
): Promise<AnnotationRoom | null> {
  let room: AnnotationRoom
  try {
    room = parseAnnotationRoomId(roomId)
  } catch {
    return null
  }

  const match = await database.match.findFirst({
    select: { id: true },
    where: {
      id: room.matchId,
      captureSessions: { some: { id: room.captureSessionId } },
      ...(identity.role === UserRole.ADMIN
        ? {}
        : {
            members: {
              some: {
                role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                userId: identity.userId,
              },
            },
          }),
    },
  })
  return match ? room : null
}
