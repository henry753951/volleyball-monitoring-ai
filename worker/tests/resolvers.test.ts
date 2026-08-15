import { describe, expect, it } from 'vitest'
import {
  MediaResolverError,
  resolveCaptureSession,
  resolveProgramProfile,
  type CaptureResolverClient,
  type ProfileClient,
} from '../src/media/resolvers.js'

function captureClient(rows: readonly { id: string; status: string }[]): CaptureResolverClient {
  return { captureSession: { findMany: async () => rows } }
}

function profileClient(
  rows: readonly {
    fpsNum: number
    fpsDen: number
    timeBaseNum: number
    timeBaseDen: number
  }[],
): ProfileClient {
  return { dvrProgram: { findMany: async () => rows } }
}

describe('media ingest persistence resolvers', () => {
  it('returns exactly one active ingest-path match and filters terminal sessions', async () => {
    await expect(
      resolveCaptureSession(
        captureClient([
          { id: 'active', status: 'LIVE' },
          { id: 'finished', status: 'FINISHED' },
          { id: 'failed', status: 'FAILED' },
        ]),
        'court-a',
      ),
    ).resolves.toBe('active')
    await expect(
      resolveCaptureSession(captureClient([{ id: 'finished', status: 'FINISHED' }]), 'court-a'),
    ).resolves.toBeNull()
    await expect(
      resolveCaptureSession(
        captureClient([
          { id: 'one', status: 'STARTING' },
          { id: 'two', status: 'STOPPING' },
        ]),
        'court-a',
      ),
    ).rejects.toMatchObject({ code: 'CAPTURE_AMBIGUOUS' })
  })

  it.each([
    {
      label: '30 fps',
      observed: {
        frameCount: 60n,
        durationPts: 180_000n,
        timeBase: { num: 1n, den: 90_000n },
      },
      expected: { fpsNum: 30, fpsDen: 1 },
    },
    {
      label: '59.94 fps',
      observed: {
        frameCount: 120n,
        durationPts: 120_120n,
        timeBase: { num: 1n, den: 60_000n },
      },
      expected: { fpsNum: 60_000, fpsDen: 1_001 },
    },
    {
      label: 'VFR observed average',
      observed: {
        frameCount: 3n,
        durationPts: 7_507n,
        timeBase: { num: 1n, den: 90_000n },
      },
      expected: { fpsNum: 270_000, fpsDen: 7_507 },
    },
  ])('derives a reduced $label descriptive profile', async ({ observed, expected }) => {
    await expect(
      resolveProgramProfile(profileClient([]), 'capture', observed),
    ).resolves.toMatchObject({
      ...expected,
      timeBaseNum: Number(observed.timeBase.num),
      timeBaseDen: Number(observed.timeBase.den),
    })
  })

  it('reuses one stable profile and rejects ambiguous or invalid persisted state', async () => {
    const stable = {
      fpsNum: 30,
      fpsDen: 1,
      timeBaseNum: 1,
      timeBaseDen: 90_000,
    }
    const observed = {
      frameCount: 1n,
      durationPts: 1n,
      timeBase: { num: 1n, den: 1n },
    }
    await expect(
      resolveProgramProfile(profileClient([stable]), 'capture', observed),
    ).resolves.toEqual(stable)
    await expect(
      resolveProgramProfile(profileClient([stable, stable]), 'capture', observed),
    ).rejects.toMatchObject({ code: 'PROGRAM_AMBIGUOUS' })
    await expect(
      resolveProgramProfile(profileClient([{ ...stable, fpsNum: 0 }]), 'capture', observed),
    ).rejects.toBeInstanceOf(MediaResolverError)
    await expect(
      resolveProgramProfile(profileClient([]), 'capture', {
        ...observed,
        timeBase: { num: 1n, den: 2_147_483_648n },
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' })
  })
})
