import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type YoutubeAuthStatus = {
  browser: 'running' | 'offline' | 'unknown'
  cookieAvailable: boolean
  sessionState: 'available' | 'login_required' | 'unknown'
  revision: string | null
  profileUpdatedAt: string | null
  lastReadAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export type YoutubeAuthSnapshot = Pick<
  YoutubeAuthStatus,
  'revision' | 'profileUpdatedAt' | 'lastReadAt'
>

type YoutubeAuthProbeOptions = {
  browserHealthUrl?: string | undefined
  cookiesFromBrowser?: string | undefined
  ytDlpCommand?: string | undefined
  extractorArgs?: string | undefined
  potProviderUrl?: string | undefined
  testUrl?: string | undefined
  statusFile?: string | undefined
  fetcher?: typeof fetch | undefined
}

const EMPTY_STATUS: YoutubeAuthStatus = {
  browser: 'unknown',
  cookieAvailable: false,
  sessionState: 'unknown',
  revision: null,
  profileUpdatedAt: null,
  lastReadAt: null,
  lastSuccessAt: null,
  lastError: null,
}

function profilePath(spec: string | undefined): string | null {
  if (!spec) return null
  const separator = spec.indexOf(':')
  return separator < 0 ? null : spec.slice(separator + 1).split('::', 1)[0] || null
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:cookie|authorization|sid|sapisisid|login_info)[^\s]*/gi, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(-240)
    .trim()
}

async function fileFingerprint(
  path: string,
): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  const metadata = await stat(path).catch(() => null)
  return metadata ? { path, size: metadata.size, mtimeMs: metadata.mtimeMs } : null
}

export async function readYoutubeAuthSnapshot(
  spec: string | undefined,
): Promise<YoutubeAuthSnapshot> {
  const root = profilePath(spec)
  if (!root) return { revision: null, profileUpdatedAt: null, lastReadAt: null }
  const files = (
    await Promise.all([
      fileFingerprint(join(root, 'Local State')),
      fileFingerprint(join(root, 'Default', 'Cookies')),
      fileFingerprint(join(root, 'Default', 'Network', 'Cookies')),
    ])
  ).filter((value): value is NonNullable<typeof value> => value !== null)
  if (files.length === 0) return { revision: null, profileUpdatedAt: null, lastReadAt: null }
  const latest = Math.max(...files.map(file => file.mtimeMs))
  const revision = `rev-${createHash('sha256')
    .update(JSON.stringify(files))
    .digest('hex')
    .slice(0, 12)}`
  return {
    revision,
    profileUpdatedAt: new Date(latest).toISOString(),
    lastReadAt: new Date().toISOString(),
  }
}

async function browserIsReachable(
  url: string | undefined,
  fetcher: typeof fetch,
): Promise<YoutubeAuthStatus['browser']> {
  if (!url) return 'unknown'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetcher(url, { signal: controller.signal })
    return response.ok ? 'running' : 'offline'
  } catch {
    return 'offline'
  } finally {
    clearTimeout(timer)
  }
}

async function runAuthProbe(options: YoutubeAuthProbeOptions): Promise<void> {
  if (!options.cookiesFromBrowser) throw new Error('YOUTUBE_COOKIES_FROM_BROWSER is not configured')
  if (!options.testUrl) throw new Error('YOUTUBE_AUTH_TEST_URL is not configured')
  const args = [
    '--skip-download',
    '--no-playlist',
    '--no-progress',
    '--no-warnings',
    '--print',
    'id',
    '--cookies-from-browser',
    options.cookiesFromBrowser,
    ...(options.extractorArgs ? ['--extractor-args', options.extractorArgs] : []),
    ...(options.potProviderUrl
      ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${options.potProviderUrl}`]
      : []),
    options.testUrl,
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ytDlpCommand ?? 'yt-dlp', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    const stderr: Buffer[] = []
    child.stderr?.on('data', chunk => {
      const next = Buffer.concat([...stderr, Buffer.from(chunk)])
      stderr.length = 0
      stderr.push(next.subarray(-32_768))
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else
        reject(new Error(`yt-dlp auth probe exited ${code}: ${safeError(Buffer.concat(stderr))}`))
    })
  })
}

export function createYoutubeAuthProbe(options: YoutubeAuthProbeOptions) {
  let status: YoutubeAuthStatus = { ...EMPTY_STATUS }

  const snapshot = () => readYoutubeAuthSnapshot(options.cookiesFromBrowser)

  const refresh = async (): Promise<YoutubeAuthStatus> => {
    const startedAt = new Date().toISOString()
    const before = await snapshot()
    try {
      await runAuthProbe(options)
      const after = await snapshot()
      status = {
        ...status,
        ...after,
        browser: await browserIsReachable(options.browserHealthUrl, options.fetcher ?? fetch),
        cookieAvailable: Boolean(after.revision),
        sessionState: 'available',
        lastReadAt: after.lastReadAt ?? startedAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      }
    } catch (error) {
      status = {
        ...status,
        ...before,
        browser: await browserIsReachable(options.browserHealthUrl, options.fetcher ?? fetch),
        cookieAvailable: false,
        sessionState: /login|private|confirm|sign in/i.test(safeError(error))
          ? 'login_required'
          : 'unknown',
        lastReadAt: before.lastReadAt ?? startedAt,
        lastError: safeError(error),
      }
    }
    if (options.statusFile) {
      await mkdir(dirname(options.statusFile), { recursive: true })
      await writeFile(options.statusFile, JSON.stringify(status), 'utf8')
    }
    return { ...status }
  }

  return {
    get status() {
      return { ...status }
    },
    snapshot,
    refresh,
  }
}
