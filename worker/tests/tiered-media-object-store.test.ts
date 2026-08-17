import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256, type MediaArtifact } from '../src/media/artifacts.js'
import type { MediaObjectStore } from '../src/media/ingest.js'
import { createTieredMediaObjectStore } from '../src/media/tiered-media-object-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function artifact(): MediaArtifact {
  const bytes = Buffer.from('hot-media-segment')
  return {
    kind: 'media',
    location: { bucket: 'dvr-media', key: 'capture/hash/media.m4s' },
    bytes,
    byteLength: BigInt(bytes.byteLength),
    contentType: 'video/mp4',
    internalSchemaVersion: '1.0.0',
    sha256: sha256(bytes),
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

describe('tiered media object store', () => {
  it('publishes to the local hot tier before asynchronously archiving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vollyai-hot-store-'))
    roots.push(root)
    let releaseArchive!: () => void
    const archiveBlocked = new Promise<void>(resolve => {
      releaseArchive = resolve
    })
    const verifyArchive = vi.fn(async () => undefined)
    const archive: MediaObjectStore = {
      upload: vi.fn(async () => archiveBlocked),
      verify: verifyArchive,
    }
    const store = createTieredMediaObjectStore({ root, archive, archiveConcurrency: 2 })
    await store.start()
    const value = artifact()
    await store.upload(value)
    await store.verify(value)

    expect(await readFile(join(root, 'dvr-media', 'capture', 'hash', 'media.m4s'))).toEqual(
      value.bytes,
    )
    expect(store.snapshot.pending).toBeGreaterThan(0)
    releaseArchive()
    await waitFor(() => verifyArchive.mock.calls.length === 1)
    await store.stop()
  })

  it('recovers durable archive receipts after a worker restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vollyai-hot-recovery-'))
    roots.push(root)
    const dormant = createTieredMediaObjectStore({
      root,
      archive: { upload: async () => undefined, verify: async () => undefined },
    })
    await dormant.upload(artifact())

    const verifyArchive = vi.fn(async () => undefined)
    const archive: MediaObjectStore = {
      upload: vi.fn(async () => undefined),
      verify: verifyArchive,
    }
    const recovered = createTieredMediaObjectStore({ root, archive })
    await recovered.start()
    await waitFor(() => verifyArchive.mock.calls.length === 1)
    const directory = join(root, 'dvr-media', 'capture', 'hash')
    expect((await readdir(directory)).some(name => name.endsWith('.archive-pending.json'))).toBe(
      false,
    )
    await recovered.stop()
  })
})
