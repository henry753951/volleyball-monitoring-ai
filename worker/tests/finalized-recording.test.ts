import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSourceIdentity, parseFinalizedRecording } from '../src/media/finalized-recording'

const sandboxes: string[] = []

async function createSandbox(): Promise<{
  sandbox: string
  spool: string
}> {
  const sandbox = await mkdtemp(join(tmpdir(), 'volleyball-media-'))
  sandboxes.push(sandbox)
  const spool = join(sandbox, 'spool')
  await mkdir(join(spool, 'nested'), { recursive: true })
  return { sandbox, spool }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('finalized recording discovery', () => {
  it('returns a trusted absolute path and normalized relative identity from stat', async () => {
    const { spool } = await createSandbox()
    await writeFile(join(spool, 'nested', 'segment-01.m4s'), Uint8Array.of(1, 2, 3))

    const recording = await parseFinalizedRecording({
      spoolRoot: spool,
      candidate: join('nested', 'segment-01.m4s'),
      captureSessionId: 'capture-01',
      finalized: true,
    })

    expect(isAbsolute(recording.trustedPath)).toBe(true)
    expect(recording.sourceIdentity).toBe('nested/segment-01.m4s')
    expect(recording.byteLength).toBe(3n)
    expect(recording.mtimeNs).toBeTypeOf('bigint')
    expect(recording.finalized).toBe(true)
    expect(recording).not.toHaveProperty('sha256')
    expect(recording).not.toHaveProperty('contentType')
  })

  it('rejects absolute and traversal candidates', async () => {
    const { sandbox, spool } = await createSandbox()
    const outside = join(sandbox, 'outside.mp4')
    await writeFile(outside, Uint8Array.of(1))

    await expect(
      parseFinalizedRecording({
        spoolRoot: spool,
        candidate: outside,
        captureSessionId: 'capture-01',
        finalized: true,
      }),
    ).rejects.toThrow('must be relative')
    await expect(
      parseFinalizedRecording({
        spoolRoot: spool,
        candidate: '../outside.mp4',
        captureSessionId: 'capture-01',
        finalized: true,
      }),
    ).rejects.toThrow('escapes spool root')
  })

  it('rejects empty files and unsupported extensions', async () => {
    const { spool } = await createSandbox()
    await writeFile(join(spool, 'nested', 'empty.mp4'), new Uint8Array())
    await writeFile(join(spool, 'nested', 'segment.txt'), Uint8Array.of(1))

    await expect(
      parseFinalizedRecording({
        spoolRoot: spool,
        candidate: 'nested/empty.mp4',
        captureSessionId: 'capture-01',
        finalized: true,
      }),
    ).rejects.toThrow('recording is empty')
    await expect(
      parseFinalizedRecording({
        spoolRoot: spool,
        candidate: 'nested/segment.txt',
        captureSessionId: 'capture-01',
        finalized: true,
      }),
    ).rejects.toThrow('unknown recording extension')
  })

  it('normalizes separators while rejecting identity traversal', () => {
    expect(normalizeSourceIdentity('nested\\segment-01.m4s')).toBe('nested/segment-01.m4s')
    expect(() => normalizeSourceIdentity('../segment-01.m4s')).toThrow('invalid source identity')
    expect(() => normalizeSourceIdentity('nested//segment-01.m4s')).toThrow(
      'invalid source identity',
    )
  })
})
