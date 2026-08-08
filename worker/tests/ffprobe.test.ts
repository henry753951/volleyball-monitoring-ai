import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNodeProbeRunner,
  FfprobeError,
  runFfprobe,
  type ProbeRunner,
  type SpawnLike,
} from '../src/media/ffprobe'

const validProbe = JSON.stringify({
  streams: [{ codec_type: 'video', time_base: '1/30', start_pts: '9007199254740993', duration_ts: '1' }],
  frames: [
    { media_type: 'video', pts: '9007199254740993', pkt_duration: '1' },
  ],
})

const defaultRunnerOptions = {
  shell: false as const,
  timeoutMs: 100,
  maxOutputBytes: 1_024,
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killCalls = 0

  kill(): boolean {
    this.killCalls += 1
    return true
  }

  close(code: number | null): void {
    this.emit('close', code)
  }

  fail(error: Error): void {
    this.emit('error', error)
  }
}

type SpawnInvocation = {
  executable: string
  args: readonly string[]
  options: { shell: false }
}

function fakeSpawn(
  childOrError: FakeChildProcess | Error,
  onSpawn?: (invocation: SpawnInvocation) => void,
): SpawnLike {
  // This is the single narrow test-double cast: the adapter only consumes
  // stdout, stderr, kill, error, and close from Node's larger child API.
  return ((
    executable: string,
    args: readonly string[],
    options: { shell: false },
  ) => {
    onSpawn?.({ executable, args, options })
    if (childOrError instanceof Error) throw childOrError
    return childOrError
  }) as SpawnLike
}

function runnerFor(child: FakeChildProcess): ProbeRunner {
  return createNodeProbeRunner(fakeSpawn(child))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createNodeProbeRunner', () => {
  it('maps a synchronous spawn failure to SPAWN_FAILED', async () => {
    await expect(
      createNodeProbeRunner(fakeSpawn(new Error('executable missing')))(
        'ffprobe',
        ['recording.mp4'],
        defaultRunnerOptions,
      ),
    ).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      message: 'executable missing',
    })
  })

  it('maps an emitted spawn failure to SPAWN_FAILED', async () => {
    const child = new FakeChildProcess()
    const pending = runnerFor(child)(
      'ffprobe',
      ['recording.mp4'],
      defaultRunnerOptions,
    )
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      message: 'permission denied',
    })

    child.fail(new Error('permission denied'))

    await rejection
    expect(child.killCalls).toBe(1)
  })

  it('rejects stdout overflow and kills exactly once', async () => {
    const child = new FakeChildProcess()
    const pending = runnerFor(child)('ffprobe', [], {
      ...defaultRunnerOptions,
      maxOutputBytes: 3,
    })
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'OUTPUT_TOO_LARGE',
    })

    child.stdout.write('1234')

    await rejection
    expect(child.killCalls).toBe(1)
  })

  it('rejects stderr overflow and kills exactly once', async () => {
    const child = new FakeChildProcess()
    const pending = runnerFor(child)('ffprobe', [], {
      ...defaultRunnerOptions,
      maxOutputBytes: 3,
    })
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'OUTPUT_TOO_LARGE',
    })

    child.stderr.write('1234')

    await rejection
    expect(child.killCalls).toBe(1)
  })

  it('times out and kills exactly once', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    const pending = runnerFor(child)('ffprobe', [], {
      ...defaultRunnerOptions,
      timeoutMs: 25,
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(child.killCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an already-aborted probe and kills exactly once', async () => {
    const controller = new AbortController()
    controller.abort()
    const child = new FakeChildProcess()

    await expect(
      runnerFor(child)('ffprobe', [], {
        ...defaultRunnerOptions,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(child.killCalls).toBe(1)
  })

  it('cancels on a later abort and kills exactly once', async () => {
    const controller = new AbortController()
    const child = new FakeChildProcess()
    const pending = runnerFor(child)('ffprobe', [], {
      ...defaultRunnerOptions,
      signal: controller.signal,
    })
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    })

    controller.abort()

    await rejection
    expect(child.killCalls).toBe(1)
  })

  it('returns exact output and removes timeout and abort cleanup', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const child = new FakeChildProcess()
    let invocation: SpawnInvocation | undefined
    const pending = createNodeProbeRunner(
      fakeSpawn(child, (value) => {
        invocation = value
      }),
    )('ffprobe-custom', ['recording.mp4'], {
      ...defaultRunnerOptions,
      signal: controller.signal,
    })

    child.stdout.write('{"frames":')
    child.stdout.write('[]}')
    child.stderr.write('diagnostic\n')
    child.close(0)

    await expect(pending).resolves.toEqual({
      code: 0,
      stdout: '{"frames":[]}',
      stderr: 'diagnostic\n',
    })
    expect(invocation).toEqual({
      executable: 'ffprobe-custom',
      args: ['recording.mp4'],
      options: { shell: false },
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener.mock.calls[0]).toEqual([
      'abort',
      addListener.mock.calls[0]![1],
    ])
    expect(child.killCalls).toBe(0)
  })

  it('ignores close and error events after a kill without double-settling', async () => {
    const controller = new AbortController()
    const child = new FakeChildProcess()
    const pending = runnerFor(child)('ffprobe', [], {
      ...defaultRunnerOptions,
      signal: controller.signal,
    })
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    })

    controller.abort()
    child.close(0)
    child.fail(new Error('late error'))

    await rejection
    expect(child.killCalls).toBe(1)
  })
})

describe('runFfprobe', () => {
  it('passes the exact selected-field argv and keeps metacharacters in one arg', async () => {
    let invocation: {
      executable: string
      args: string[]
      options: {
        shell: false
        timeoutMs: number
        maxOutputBytes: number
        signal?: AbortSignal
      }
    } | undefined
    const filePath = 'C:/captures/game one & echo owned; $(bad).mp4'

    const result = await runFfprobe(filePath, {
      executable: 'custom-ffprobe',
      runner: async (executable, args, options) => {
        invocation = { executable, args, options }
        return { code: 0, stdout: validProbe, stderr: '' }
      },
    })

    expect(result.frames).toHaveLength(1)
    expect(result.streamEndPtsExclusive).toBe(9_007_199_254_740_994n)
    expect(invocation).toEqual({
      executable: 'custom-ffprobe',
      args: [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'stream=codec_type,time_base,start_pts,duration_ts:frame=media_type,pts,pkt_duration,key_frame',
        filePath,
      ],
      options: {
        shell: false,
        timeoutMs: 10_000,
        maxOutputBytes: 2_000_000,
      },
    })
  })

  it('maps a nonzero exit', async () => {
    await expect(
      runFfprobe('recording.mp4', {
        runner: async () => ({ code: 2, stdout: '', stderr: 'bad input' }),
      }),
    ).rejects.toMatchObject({ code: 'NONZERO_EXIT', message: 'bad input' })
  })

  it('distinguishes invalid JSON from an invalid canonical probe', async () => {
    await expect(
      runFfprobe('recording.mp4', {
        runner: async () => ({ code: 0, stdout: 'not-json', stderr: '' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' })

    await expect(
      runFfprobe('recording.mp4', {
        runner: async () => ({
          code: 0,
          stdout: JSON.stringify({ streams: [], frames: [] }),
          stderr: '',
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROBE' })
  })

  it('preserves runner timeout, cancellation, and overflow errors', async () => {
    for (const code of [
      'TIMEOUT',
      'CANCELLED',
      'OUTPUT_TOO_LARGE',
    ] as const) {
      await expect(
        runFfprobe('recording.mp4', {
          runner: async () => {
            throw new FfprobeError(code, code)
          },
        }),
      ).rejects.toMatchObject({ code })
    }
  })
})
