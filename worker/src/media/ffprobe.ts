import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseFfprobePayload, type FfprobePayload } from '@volleyball-monitoring/media/sample-index'

export type FfprobeErrorCode =
  | 'SPAWN_FAILED'
  | 'NONZERO_EXIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_PROBE'

export class FfprobeError extends Error {
  constructor(
    public readonly code: FfprobeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type ProbeRunner = (
  executable: string,
  args: string[],
  options: {
    shell: false
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
  },
) => Promise<{ code: number; stdout: string; stderr: string }>

export type SpawnLike = typeof spawn

export type ProbeOptions = {
  executable?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  runner?: ProbeRunner
}

function spawnFailure(error: unknown): FfprobeError {
  return new FfprobeError('SPAWN_FAILED', error instanceof Error ? error.message : String(error))
}

export const createNodeProbeRunner =
  (spawnImpl: SpawnLike = spawn): ProbeRunner =>
  (executable, args, options) =>
    new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnImpl(executable, args, { shell: false })
      } catch (error) {
        reject(spawnFailure(error))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      // The timer is assigned only after the early-abort check below.
      // eslint-disable-next-line prefer-const
      let timeout: ReturnType<typeof setTimeout> | undefined

      const abort = () => {
        killAndReject(new FfprobeError('CANCELLED', 'cancelled'))
      }

      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        options.signal?.removeEventListener('abort', abort)
      }

      const rejectOnce = (error: FfprobeError, kill: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        if (kill) {
          try {
            child.kill()
          } catch {
            // Preserve the deterministic adapter error when process teardown fails.
          }
        }
        reject(error)
      }

      function killAndReject(error: FfprobeError) {
        rejectOnce(error, true)
      }

      const append = (
        chunks: Buffer[],
        byteLength: number,
        data: string | Uint8Array,
        overflowMessage: string,
      ): number => {
        if (settled) return byteLength
        const chunk = Buffer.from(data)
        const nextByteLength = byteLength + chunk.byteLength
        if (nextByteLength > options.maxOutputBytes) {
          killAndReject(new FfprobeError('OUTPUT_TOO_LARGE', overflowMessage))
          return nextByteLength
        }
        chunks.push(chunk)
        return nextByteLength
      }

      child.stdout.on('data', (data: string | Uint8Array) => {
        stdoutBytes = append(stdoutChunks, stdoutBytes, data, 'output too large')
      })
      child.stderr.on('data', (data: string | Uint8Array) => {
        stderrBytes = append(stderrChunks, stderrBytes, data, 'stderr too large')
      })
      child.on('error', error => {
        killAndReject(spawnFailure(error))
      })
      child.on('close', code => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        })
      })

      if (options.signal?.aborted) {
        abort()
        return
      }

      options.signal?.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(
        () => killAndReject(new FfprobeError('TIMEOUT', 'timeout')),
        options.timeoutMs,
      )
    })

const nodeRunner = createNodeProbeRunner()

export async function runFfprobe(
  filePath: string,
  options: ProbeOptions = {},
): Promise<ReturnType<typeof parseFfprobePayload>> {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'stream=codec_type,time_base,start_pts,duration_ts:frame=media_type,pts,pkt_duration,key_frame',
    filePath,
  ]
  const runnerOptions: {
    shell: false
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
  } = {
    shell: false,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
  }
  if (options.signal) runnerOptions.signal = options.signal

  const result = await (options.runner ?? nodeRunner)(
    options.executable ?? 'ffprobe',
    args,
    runnerOptions,
  )
  if (result.code !== 0) {
    throw new FfprobeError('NONZERO_EXIT', result.stderr)
  }

  let payload: FfprobePayload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new FfprobeError('INVALID_JSON', 'invalid json')
  }

  try {
    return parseFfprobePayload(payload)
  } catch {
    throw new FfprobeError('INVALID_PROBE', 'invalid probe')
  }
}
