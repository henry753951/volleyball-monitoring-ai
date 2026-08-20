import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readYoutubeAuthSnapshot } from '../src/media/youtube-auth.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })),
  )
})

describe('YouTube browser authentication snapshot', () => {
  it('changes the opaque revision when Chromium updates the active cookie WAL', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'youtube-browser-profile-'))
    temporaryDirectories.push(profile)
    const network = join(profile, 'Default', 'Network')
    await mkdir(network, { recursive: true })
    await writeFile(join(profile, 'Local State'), '{"profile":"test"}', 'utf8')
    await writeFile(join(network, 'Cookies'), 'cookie-db', 'utf8')

    const spec = `chromium+basictext:${profile}`
    const before = await readYoutubeAuthSnapshot(spec)
    await writeFile(join(network, 'Cookies-wal'), 'rotated-session-cookie-material', 'utf8')
    const after = await readYoutubeAuthSnapshot(spec)

    expect(before.revision).toMatch(/^rev-[0-9a-f]{12}$/)
    expect(after.revision).toMatch(/^rev-[0-9a-f]{12}$/)
    expect(after.revision).not.toBe(before.revision)
    expect(JSON.stringify(after)).not.toContain('rotated-session-cookie-material')
  })
})
