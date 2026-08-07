export interface ReadinessProbe {
  name: string
  check: (signal: AbortSignal) => Promise<void>
}

export type ReadinessCheckStatus = 'ok' | 'failed'

export interface ReadinessResult {
  status: 'ready' | 'unavailable'
  checks: Record<string, ReadinessCheckStatus>
}

async function runProbe(probe: ReadinessProbe, timeoutMs: number): Promise<void> {
  const controller = new AbortController()

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`readiness probe timed out: ${probe.name}`))
    }, timeoutMs)

    Promise.resolve()
      .then(() => probe.check(controller.signal))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

export async function evaluateReadiness(
  probes: ReadinessProbe[],
  timeoutMs = 1_500,
): Promise<ReadinessResult> {
  const entries = await Promise.all(probes.map(async (probe) => {
    try {
      await runProbe(probe, timeoutMs)
      return [probe.name, 'ok'] as const
    } catch {
      return [probe.name, 'failed'] as const
    }
  }))
  const checks = Object.fromEntries(entries) as Record<string, ReadinessCheckStatus>

  return {
    status: entries.every(([, status]) => status === 'ok') ? 'ready' : 'unavailable',
    checks,
  }
}
