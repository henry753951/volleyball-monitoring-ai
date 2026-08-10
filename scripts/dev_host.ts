import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function hostPath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured)
    ? configured
    : resolve(repositoryRoot, 'infra', configured)
}

export function createHostDevelopmentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const postgresPort = source.POSTGRES_HOST_PORT ?? '5433'
  const redisPort = source.REDIS_HOST_PORT ?? '16379'
  const minioPort = source.MINIO_HOST_PORT ?? '9000'
  const omeApiPort = source.OME_API_HOST_PORT ?? '8081'
  const serverPort = source.SERVER_DEV_PORT ?? '4000'
  const webPort = source.WEB_DEV_PORT ?? '3100'
  const dataRoot = hostPath(source.DEV_DATA_ROOT, '../.data/runtime')
  const spoolRoot = hostPath(source.MEDIA_SPOOL_HOST_PATH, resolve(dataRoot, 'media-spool'))
  const importRoot = hostPath(source.MEDIA_IMPORT_HOST_PATH, resolve(dataRoot, 'media-imports'))

  return {
    ...Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CALLBACK_PUBLIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
    DATABASE_URL: `postgresql://volleyball:volleyball@127.0.0.1:${postgresPort}/volleyball?schema=public`,
    MEDIA_IMPORT_ROOT: importRoot,
    MEDIA_INGEST_BASE_URL: 'rtmp://127.0.0.1:1935/app',
    MEDIA_RECORDING_ROOT: spoolRoot,
    MEDIA_SOURCE_WORK_ROOT: resolve(importRoot, '.work'),
    MEDIA_SPOOL_DIR: spoolRoot,
    MINIO_ENDPOINT: `http://127.0.0.1:${minioPort}`,
    NUXT_DEV_BACKEND_ORIGIN: `http://127.0.0.1:${serverPort}`,
    NUXT_PORT: webPort,
    OME_API_URL: `http://127.0.0.1:${omeApiPort}`,
    PORT: serverPort,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
    WORKER_MEDIA_HEALTH_PORT: source.WORKER_MEDIA_HEALTH_PORT ?? '4101',
    WORKER_WORKFLOW_HEALTH_PORT: source.WORKER_WORKFLOW_HEALTH_PORT ?? '4102',
  }
}

type DevelopmentProcess = {
  name: string
  command: string[]
  cwd: string
  environment?: Record<string, string>
}

async function waitForHostServices(environment: Record<string, string>): Promise<void> {
  const targets = [
    `http://127.0.0.1:${environment.PORT}/health/ready`,
    `http://127.0.0.1:${environment.NUXT_PORT}/`,
    `http://127.0.0.1:${environment.WORKER_MEDIA_HEALTH_PORT}/health/ready`,
    `http://127.0.0.1:${environment.WORKER_WORKFLOW_HEALTH_PORT}/health/ready`,
  ]
  const pending = new Set(targets)
  const deadline = Date.now() + 40_000
  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all([...pending].map(async (target) => {
      try {
        const response = await fetch(target, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) pending.delete(target)
      }
      catch {}
    }))
    if (pending.size > 0) await Bun.sleep(250)
  }
  if (pending.size > 0) throw new Error(`host services not ready: ${[...pending].join(', ')}`)
  console.log(`host development smoke ready: ${targets.join(', ')}`)
}

export function createDevelopmentProcesses(
  environment: Record<string, string>,
  smoke = false,
): DevelopmentProcess[] {
  return [
    { name: 'server', command: ['bun', '--watch', 'src/index.ts'], cwd: resolve(repositoryRoot, 'server') },
    {
      name: 'web',
      command: [
        'node',
        resolve(repositoryRoot, 'node_modules', '@nuxt', 'cli', 'bin', 'nuxi.mjs'),
        'dev', '--host', '0.0.0.0', '--port', environment.NUXT_PORT!,
      ],
      cwd: resolve(repositoryRoot, 'web'),
      ...(smoke ? { environment: { NUXT_IGNORE_LOCK: '1' } } : {}),
    },
    {
      name: 'worker-media',
      command: ['bun', '--watch', 'src/role-entry.ts', 'media'],
      cwd: resolve(repositoryRoot, 'worker'),
      environment: { WORKER_HEALTH_PORT: environment.WORKER_MEDIA_HEALTH_PORT! },
    },
    {
      name: 'worker-workflow',
      command: ['bun', '--watch', 'src/role-entry.ts', 'workflow'],
      cwd: resolve(repositoryRoot, 'worker'),
      environment: { WORKER_HEALTH_PORT: environment.WORKER_WORKFLOW_HEALTH_PORT! },
    },
  ]
}

async function main(): Promise<void> {
  const environment = createHostDevelopmentEnvironment()
  const smokeMode = process.argv.includes('--smoke')
  await Promise.all([
    mkdir(environment.MEDIA_SPOOL_DIR!, { recursive: true }),
    mkdir(environment.MEDIA_IMPORT_ROOT!, { recursive: true }),
  ])

  const children = createDevelopmentProcesses(environment, smokeMode).map((processDefinition) => {
    const child = Bun.spawn(processDefinition.command, {
      cwd: processDefinition.cwd,
      env: { ...environment, ...processDefinition.environment },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    console.log(`host process starting name=${processDefinition.name} pid=${child.pid}`)
    void child.exited.then(code => console.log(`host process exited name=${processDefinition.name} code=${code}`))
    return { name: processDefinition.name, process: child }
  })
  let stopping = false
  let shutdownRequested = false
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const child of children) child.process.kill()
  }
  const requestShutdown = () => {
    shutdownRequested = true
    stop()
  }
  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)
  const smoke = smokeMode
    ? waitForHostServices(environment).finally(requestShutdown)
    : undefined

  const completed = await Promise.race(children.map(async child => ({
    name: child.name,
    exitCode: await child.process.exited,
  })))
  stop()
  await Promise.allSettled(children.map(child => child.process.exited))
  process.off('SIGINT', requestShutdown)
  process.off('SIGTERM', requestShutdown)
  await smoke
  if (!shutdownRequested) {
    throw new Error(`${completed.name} exited with code ${completed.exitCode}`)
  }
}

if (import.meta.main) await main()
