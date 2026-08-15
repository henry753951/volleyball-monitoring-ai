import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/client/client.js'

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  match: '00000000-0000-4000-8000-000000000010',
  leftTeam: '00000000-0000-4000-8000-000000000011',
  rightTeam: '00000000-0000-4000-8000-000000000012',
  leftPlayer: '00000000-0000-4000-8000-000000000021',
  rightPlayer: '00000000-0000-4000-8000-000000000022',
  set: '00000000-0000-4000-8000-000000000030',
  assignment: '00000000-0000-4000-8000-000000000031',
  leftRoster: '00000000-0000-4000-8000-000000000041',
  rightRoster: '00000000-0000-4000-8000-000000000042',
}

await db.$transaction(async tx => {
  await tx.user.upsert({
    where: { email: 'dev.operator@volleyball.local' },
    update: { displayName: 'Dev Operator' },
    create: { id: ids.user, email: 'dev.operator@volleyball.local', displayName: 'Dev Operator' },
  })
  await tx.team.upsert({
    where: { id: ids.leftTeam },
    update: { name: 'Japan U16', shortName: 'JPN' },
    create: { id: ids.leftTeam, name: 'Japan U16', shortName: 'JPN' },
  })
  await tx.team.upsert({
    where: { id: ids.rightTeam },
    update: { name: 'India U16', shortName: 'IND' },
    create: { id: ids.rightTeam, name: 'India U16', shortName: 'IND' },
  })
  await tx.player.upsert({
    where: { id: ids.leftPlayer },
    update: { name: 'Japan #1' },
    create: { id: ids.leftPlayer, teamId: ids.leftTeam, name: 'Japan #1' },
  })
  await tx.player.upsert({
    where: { id: ids.rightPlayer },
    update: { name: 'India #1' },
    create: { id: ids.rightPlayer, teamId: ids.rightTeam, name: 'India #1' },
  })
  await tx.match.upsert({
    where: { id: ids.match },
    update: { title: 'DEMO · Japan U16 vs India U16', venue: 'Nakhon Pathom', status: 'LIVE' },
    create: {
      id: ids.match,
      title: 'DEMO · Japan U16 vs India U16',
      venue: 'Nakhon Pathom',
      status: 'LIVE',
    },
  })
  await tx.matchTeam.upsert({
    where: { matchId_teamId: { matchId: ids.match, teamId: ids.leftTeam } },
    update: {},
    create: { matchId: ids.match, teamId: ids.leftTeam },
  })
  await tx.matchTeam.upsert({
    where: { matchId_teamId: { matchId: ids.match, teamId: ids.rightTeam } },
    update: {},
    create: { matchId: ids.match, teamId: ids.rightTeam },
  })
  await tx.matchMember.upsert({
    where: { matchId_userId: { matchId: ids.match, userId: ids.user } },
    update: { role: 'OPERATOR' },
    create: { matchId: ids.match, userId: ids.user, role: 'OPERATOR' },
  })
  await tx.matchSet.upsert({
    where: { id: ids.set },
    update: {},
    create: { id: ids.set, matchId: ids.match, setNumber: 1 },
  })
  await tx.courtSideAssignment.upsert({
    where: { id: ids.assignment },
    update: {},
    create: {
      id: ids.assignment,
      setId: ids.set,
      effectiveFromRallyOrdinal: 1,
      leftTeamId: ids.leftTeam,
      rightTeamId: ids.rightTeam,
    },
  })
  await tx.matchRosterEntry.upsert({
    where: { id: ids.leftRoster },
    update: { displayNameSnapshot: 'Japan #1' },
    create: {
      id: ids.leftRoster,
      matchId: ids.match,
      teamId: ids.leftTeam,
      playerId: ids.leftPlayer,
      jerseyNumber: '1',
      displayNameSnapshot: 'Japan #1',
    },
  })
  await tx.matchRosterEntry.upsert({
    where: { id: ids.rightRoster },
    update: { displayNameSnapshot: 'India #1' },
    create: {
      id: ids.rightRoster,
      matchId: ids.match,
      teamId: ids.rightTeam,
      playerId: ids.rightPlayer,
      jerseyNumber: '1',
      displayNameSnapshot: 'India #1',
    },
  })
})
await db.$disconnect()
console.log('Development seed applied')
