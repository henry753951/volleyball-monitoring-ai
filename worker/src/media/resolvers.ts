import type { Rational } from '@volleyball-monitoring/media'
import type { DvrProgramProfile } from './prisma-ingest-repository.js'

const INT32_MAX = 2_147_483_647n
const ACTIVE_CAPTURE_STATUSES = ['STARTING', 'LIVE', 'STOPPING'] as const

export type MediaResolverErrorCode = 'CAPTURE_AMBIGUOUS' | 'PROGRAM_AMBIGUOUS' | 'PROFILE_INVALID'

export class MediaResolverError extends Error {
  readonly permanent = true

  constructor(public readonly code: MediaResolverErrorCode) {
    super('Media ingest resolver rejected persisted state.')
    this.name = 'MediaResolverError'
  }
}

export type CaptureResolverClient = {
  captureSession: {
    findMany(args: {
      select: { id: true; status: true }
      where: { ingestPath: string }
    }): Promise<readonly { id: string; status: string }[]>
  }
}

export async function resolveCaptureSession(
  client: CaptureResolverClient,
  ingestPath: string,
): Promise<string | null> {
  const rows = await client.captureSession.findMany({
    select: { id: true, status: true },
    where: { ingestPath },
  })
  const active = rows.filter(row =>
    ACTIVE_CAPTURE_STATUSES.includes(row.status as (typeof ACTIVE_CAPTURE_STATUSES)[number]),
  )
  if (active.length > 1) throw new MediaResolverError('CAPTURE_AMBIGUOUS')
  return active[0]?.id ?? null
}

export type ProfileClient = {
  dvrProgram: {
    findMany(args: {
      orderBy: { createdAt: 'asc' }
      select: {
        fpsNum: true
        fpsDen: true
        timeBaseNum: true
        timeBaseDen: true
      }
      where: { captureSessionId: string }
    }): Promise<readonly DvrProgramProfile[]>
  }
}

export type ObservedProgramProfile = {
  frameCount: bigint
  durationPts: bigint
  timeBase: Rational
}

function positiveInt32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= Number(INT32_MAX)
}

function validatePersistedProfile(profile: DvrProgramProfile): DvrProgramProfile {
  if (
    !positiveInt32(profile.fpsNum) ||
    !positiveInt32(profile.fpsDen) ||
    !positiveInt32(profile.timeBaseNum) ||
    !positiveInt32(profile.timeBaseDen)
  )
    throw new MediaResolverError('PROFILE_INVALID')
  return profile
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left
  let b = right
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

export async function resolveProgramProfile(
  client: ProfileClient,
  captureSessionId: string,
  observed: ObservedProgramProfile,
): Promise<DvrProgramProfile> {
  const rows = await client.dvrProgram.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      fpsNum: true,
      fpsDen: true,
      timeBaseNum: true,
      timeBaseDen: true,
    },
    where: { captureSessionId },
  })
  if (rows.length > 1) throw new MediaResolverError('PROGRAM_AMBIGUOUS')
  if (rows.length === 1) return validatePersistedProfile(rows[0]!)

  const { frameCount, durationPts, timeBase } = observed
  if (frameCount <= 0n || durationPts <= 0n || timeBase.num <= 0n || timeBase.den <= 0n)
    throw new MediaResolverError('PROFILE_INVALID')

  const numerator = frameCount * timeBase.den
  const denominator = durationPts * timeBase.num
  const divisor = greatestCommonDivisor(numerator, denominator)
  const fpsNum = numerator / divisor
  const fpsDen = denominator / divisor
  if (
    fpsNum > INT32_MAX ||
    fpsDen > INT32_MAX ||
    timeBase.num > INT32_MAX ||
    timeBase.den > INT32_MAX
  )
    throw new MediaResolverError('PROFILE_INVALID')

  return {
    fpsNum: Number(fpsNum),
    fpsDen: Number(fpsDen),
    timeBaseNum: Number(timeBase.num),
    timeBaseDen: Number(timeBase.den),
  }
}
