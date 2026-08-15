import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const compose = ['docker', 'compose', '--env-file', '.env', '-f', 'infra/compose.yaml']

function run(arguments_: string[], allowFailure = false): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(arguments_[0]!, arguments_.slice(1), {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0 || allowFailure) resolvePromise()
      else reject(new Error(`${arguments_.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function main(): Promise<void> {
  await run(
    [
      ...compose,
      '--profile',
      'app',
      'stop',
      'server',
      'web',
      'worker-media',
      'worker-workflow',
      'traefik',
    ],
    true,
  )
  await run(
    [
      ...compose,
      '--profile',
      'app',
      'rm',
      '-f',
      'server',
      'web',
      'worker-media',
      'worker-workflow',
      'traefik',
    ],
    true,
  )
  await run([
    ...compose,
    'up',
    '-d',
    '--remove-orphans',
    'postgres',
    'redis',
    'minio',
    'ovenmediaengine',
  ])
  await run(['bun', 'run', 'storage:bootstrap'])
  if (process.argv.includes('--https')) {
    await run([...compose, '-f', 'infra/compose.host-dev.yaml', 'up', '-d', 'traefik'])
  }
}

await main()
