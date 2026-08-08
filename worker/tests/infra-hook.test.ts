import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HOOK_PATH = 'infra/ome/indexer_hook.py'
const UV = process.env.TEST_UV_EXECUTABLE ?? 'uv'
const TOKEN = 'phase2a-hook-test-token-change-me-now'
const temporaryDirectories: string[] = []

async function runProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(executable, args, {
    cwd: REPOSITORY_ROOT,
    env,
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const [code] = await once(child, 'close') as [number | null]
  return { code, stderr }
}

function runHook(args: string[], env: NodeJS.ProcessEnv) {
  return runProcess(UV, [
    'run',
    '--project',
    'sdk',
    '--frozen',
    'python',
    HOOK_PATH,
    ...args,
  ], env)
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('OME recording completion hook', () => {
  it('uses the fixed private hook and read-only spool wiring', async () => {
    const compose = await readFile(new URL('../../infra/compose.yaml', import.meta.url), 'utf8')
    const hook = await readFile(new URL('../../infra/ome/indexer_hook.py', import.meta.url), 'utf8')
    const ome = await readFile(new URL('../../infra/ome/Server.xml', import.meta.url), 'utf8')
    const relay = await readFile(new URL('../../infra/youtube-relay/gateway.py', import.meta.url), 'utf8')
    expect(compose).toContain('ovenmedialabs/ovenmediaengine:v0.20.5')
    expect(compose).toContain('media-spool:/var/lib/volleyball/media-spool:ro')
    expect(compose).toContain('${MEDIA_INDEXER_HOOK_TOKEN:?MEDIA_INDEXER_HOOK_TOKEN is required}')
    expect(compose).not.toContain('4100:4100')
    expect(ome).toContain('<LLHLS>')
    expect(ome).toContain('<FILE>')
    expect(ome).toContain('<DVR>')
    expect(hook).not.toContain('eval(')
    expect(relay).toContain('--get-url')
    expect(relay).toContain("'-re', '-i'")
    expect(relay).not.toContain('--output -')
  })

  it('posts hostile path data without shell evaluation', async () => {
    const requests: Array<{ headers: NodeJS.Dict<string | string[]>; body: string }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push({ headers: request.headers, body })
        response.statusCode = 202
        response.end()
      })
    })
    const port = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'volleyball-hook-'))
    temporaryDirectories.push(directory)
    const sentinel = join(directory, 'must-not-exist')
    const path = `folder name/quote"; & $() 雪.m4s; echo pwned > ${sentinel}`

    try {
      const result = await runHook(['recording_complete', path], {
        ...process.env,
        MEDIA_INDEXER_HOOK_URL: `http://127.0.0.1:${port}/internal/media-indexer/recording-complete`,
        MEDIA_INDEXER_HOOK_TOKEN: TOKEN,
      })
      expect(result, result.stderr).toMatchObject({ code: 0 })
      expect(requests).toHaveLength(1)
      expect(JSON.parse(requests[0]!.body)).toEqual({ event: 'recording_complete', path })
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(requests[0]!.headers['content-type']).toBe('application/json')
      await expect(access(sentinel)).rejects.toThrow()
    } finally {
      await close(server)
    }
  })

  it.each([
    ['newline', 'recordings/a\nb.m4s'],
    ['overlong', 'x'.repeat(5000)],
  ])('rejects %s paths before issuing a request', async (_name, path) => {
    let requestCount = 0
    const server = createServer((_request, response) => {
      requestCount += 1
      response.statusCode = 202
      response.end()
    })
    const port = await listen(server)
    try {
      const result = await runHook(['recording_complete', path], {
        ...process.env,
        MEDIA_INDEXER_HOOK_URL: `http://127.0.0.1:${port}/internal/media-indexer/recording-complete`,
        MEDIA_INDEXER_HOOK_TOKEN: TOKEN,
      })
      expect(result.code).toBe(2)
      expect(requestCount).toBe(0)
    } finally {
      await close(server)
    }
  })

  it('rejects a NUL path before networking', async () => {
    const modulePath = JSON.stringify(fileURLToPath(new URL(`../../${HOOK_PATH}`, import.meta.url)))
    const code = `import runpy; runpy.run_path(${modulePath})['validate_path']('a\\x00b')`
    const result = await runProcess(UV, [
      'run',
      '--project',
      'sdk',
      '--frozen',
      'python',
      '-c',
      code,
    ])
    expect(result.code).not.toBe(0)
  })

  it.each([401, 500])('exits nonzero on HTTP %s', async status => {
    const server = createServer((_request, response) => {
      response.statusCode = status
      response.end()
    })
    const port = await listen(server)
    try {
      const result = await runHook(['recording_complete', 'recordings/cam/final.m4s'], {
        ...process.env,
        MEDIA_INDEXER_HOOK_URL: `http://127.0.0.1:${port}/internal/media-indexer/recording-complete`,
        MEDIA_INDEXER_HOOK_TOKEN: TOKEN,
      })
      expect(result.code).toBe(1)
    } finally {
      await close(server)
    }
  })

  it('persists a source restart marker before notifying the indexer', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => { requests.push(body); response.statusCode = 202; response.end() })
    })
    const port = await listen(server)
    const root = await mkdtemp(join(tmpdir(), 'volleyball-restart-marker-'))
    temporaryDirectories.push(root)
    try {
      const result = await runHook(['source_offline', 'match-a/main'], {
        ...process.env,
        MEDIA_RECORDING_ROOT: root,
        MEDIA_INDEXER_HOOK_URL: `http://127.0.0.1:${port}/internal/media-indexer/recording-complete`,
        MEDIA_INDEXER_HOOK_TOKEN: TOKEN,
      })
      expect(result, result.stderr).toMatchObject({ code: 0 })
      expect(JSON.parse(requests[0]!)).toEqual({ event: 'source_offline', ingest_path: 'match-a/main' })
      const files = await import('node:fs/promises').then(fs => fs.readdir(join(root, 'match-a', 'main')))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^\.source-restart-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}\.marker$/)
    } finally {
      await close(server)
    }
  })
})
