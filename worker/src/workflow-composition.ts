import type { PrismaClient } from '@volleyball-monitoring/db'
import type { PollingLifecycle } from './workflow/poller.js'
import { createAnalysisIngestWorker } from './roles/analysis-ingest.js'
import { createClipWorker } from './roles/clip-worker.js'
import { createContactAssociationWorker } from './roles/contact-association-worker.js'
import { createIdentityPreviewWorker } from './roles/identity-preview-worker.js'
import { createHighlightExportWorker } from './roles/highlight-export-worker.js'
import { createJerseySuggestionWorker } from './roles/jersey-suggestion-worker.js'
import {
  createOutboxPublisherWorker,
  createPgBossOutboxPublisher,
} from './roles/outbox-publisher.js'
import { createPlaybackPackagerWorker } from './roles/playback-packager.js'
import { createProviderAnalysisMaterializerWorker } from './roles/provider-analysis-materializer.js'
import { createReidAssociationWorker } from './roles/reid-association-worker.js'
import { createReidFeatureWorker } from './roles/reid-feature-worker.js'
import type { WorkerComponentHealth } from './runtime-health.js'

export const workflowModuleNames = [
  'clip',
  'playback-cleanup',
  'analysis-convergence',
  'provider-analysis-materializer',
  'contact-association',
  'reid-feature',
  'reid-association',
  'identity-preview',
  'highlight-export',
  'jersey-suggestion',
  'outbox',
] as const

export type WorkflowModuleName = (typeof workflowModuleNames)[number]
export type WorkflowModuleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type WorkflowModuleHealth = {
  name: WorkflowModuleName
  state: WorkflowModuleState
  lastErrorAt: string | null
  lastErrorName: string | null
}

export type NamedWorkflowLifecycle = {
  name: WorkflowModuleName
  lifecycle: PollingLifecycle
}

export type WorkflowComposition = PollingLifecycle & {
  snapshot(): WorkflowModuleHealth[]
  healthSnapshot(): WorkerComponentHealth[]
  recordError(name: WorkflowModuleName, error: unknown): void
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError')

export function composeWorkflowLifecycles(
  modules: NamedWorkflowLifecycle[],
  disconnect: () => Promise<void>,
): WorkflowComposition {
  const names = new Set(modules.map(module => module.name))
  if (names.size !== modules.length) throw new TypeError('workflow module names must be unique')

  const health = new Map<WorkflowModuleName, WorkflowModuleHealth>(
    modules.map(module => [
      module.name,
      { name: module.name, state: 'idle', lastErrorAt: null, lastErrorName: null },
    ]),
  )
  const started: NamedWorkflowLifecycle[] = []
  let disconnected = false

  const disconnectOnce = async () => {
    if (disconnected) return
    disconnected = true
    await disconnect()
  }

  const stopModules = async (targets: NamedWorkflowLifecycle[]) => {
    const results = await Promise.allSettled(
      [...targets].reverse().map(async module => {
        health.get(module.name)!.state = 'stopping'
        try {
          await module.lifecycle.stop()
          health.get(module.name)!.state = 'stopped'
        } catch (error) {
          const state = health.get(module.name)!
          state.state = 'failed'
          state.lastErrorAt = new Date().toISOString()
          state.lastErrorName = errorName(error)
          throw error
        }
      }),
    )
    return results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  }

  return {
    async start() {
      try {
        for (const module of modules) {
          health.get(module.name)!.state = 'starting'
          await module.lifecycle.start()
          health.get(module.name)!.state = 'running'
          started.push(module)
        }
      } catch (error) {
        const starting = modules[started.length]
        if (starting) {
          const state = health.get(starting.name)!
          state.state = 'failed'
          state.lastErrorAt = new Date().toISOString()
          state.lastErrorName = errorName(error)
        }
        const cleanupFailures = await stopModules(started)
        await disconnectOnce()
        if (cleanupFailures.length) {
          throw new AggregateError(
            [error, ...cleanupFailures.map(failure => failure.reason)],
            'workflow startup and cleanup failed',
            { cause: error },
          )
        }
        throw error
      }
    },
    async stop() {
      const failures = await stopModules(started)
      try {
        await disconnectOnce()
      } catch (error) {
        failures.push({ status: 'rejected', reason: error })
      }
      if (failures.length) {
        throw new AggregateError(
          failures.map(failure => failure.reason),
          'workflow shutdown failed',
        )
      }
    },
    snapshot() {
      return modules.map(module => ({ ...health.get(module.name)! }))
    },
    healthSnapshot() {
      return modules.map(module => {
        const state = health.get(module.name)!
        const polling = module.lifecycle.runtimeSnapshot?.()
        const stopped = ['idle', 'stopping', 'stopped', 'failed'].includes(state.state)
        const lastErrorAt = polling?.lastErrorAt ?? state.lastErrorAt
        const lastErrorName = polling?.lastErrorName ?? state.lastErrorName
        const status = stopped
          ? ('unhealthy' as const)
          : lastErrorAt && (!polling?.lastSuccessAt || lastErrorAt > polling.lastSuccessAt)
            ? ('degraded' as const)
            : ('healthy' as const)
        return {
          name: module.name,
          critical: module.name === 'clip',
          status,
          activeWork: polling?.active ? 1 : 0,
          failedJobs: polling?.failedCount ?? (lastErrorAt ? 1 : 0),
          backlog: null,
          lastHeartbeatAt: polling?.lastHeartbeatAt ?? null,
          lastSuccessAt: polling?.lastSuccessAt ?? null,
          lastErrorAt,
          lastErrorName,
        }
      })
    },
    recordError(name, error) {
      const state = health.get(name)
      if (!state) return
      state.lastErrorAt = new Date().toISOString()
      state.lastErrorName = errorName(error)
    },
  }
}

export function createWorkflowComposition(
  database: PrismaClient,
  connectionString: string,
): WorkflowComposition {
  // The reporter closures are created before the composition is assembled.
  let composition: WorkflowComposition | undefined
  const report = (name: WorkflowModuleName) => (error: unknown) =>
    composition?.recordError(name, error)
  const sharedOptions = { disconnectOnStop: false }

  composition = composeWorkflowLifecycles(
    [
      {
        name: 'clip',
        lifecycle: createClipWorker(database, { ...sharedOptions, onError: report('clip') }),
      },
      {
        name: 'playback-cleanup',
        lifecycle: createPlaybackPackagerWorker(database, {
          ...sharedOptions,
          onError: report('playback-cleanup'),
        }),
      },
      {
        name: 'analysis-convergence',
        lifecycle: createAnalysisIngestWorker(database, {
          ...sharedOptions,
          onError: report('analysis-convergence'),
        }),
      },
      {
        name: 'provider-analysis-materializer',
        lifecycle: createProviderAnalysisMaterializerWorker(database, {
          ...sharedOptions,
          onError: report('provider-analysis-materializer'),
        }),
      },
      {
        name: 'contact-association',
        lifecycle: createContactAssociationWorker(database, {
          ...sharedOptions,
          onError: report('contact-association'),
        }),
      },
      {
        name: 'reid-feature',
        lifecycle: createReidFeatureWorker(database, {
          ...sharedOptions,
          onError: report('reid-feature'),
        }),
      },
      {
        name: 'reid-association',
        lifecycle: createReidAssociationWorker(database, {
          ...sharedOptions,
          onError: report('reid-association'),
        }),
      },
      {
        name: 'identity-preview',
        lifecycle: createIdentityPreviewWorker(database, {
          ...sharedOptions,
          onError: report('identity-preview'),
        }),
      },
      {
        name: 'highlight-export',
        lifecycle: createHighlightExportWorker(database, {
          ...sharedOptions,
          onError: report('highlight-export'),
        }),
      },
      {
        name: 'jersey-suggestion',
        lifecycle: createJerseySuggestionWorker(database, {
          ...sharedOptions,
          onError: report('jersey-suggestion'),
        }),
      },
      {
        name: 'outbox',
        lifecycle: createOutboxPublisherWorker(
          database,
          createPgBossOutboxPublisher(connectionString),
          { ...sharedOptions, onError: report('outbox') },
        ),
      },
    ],
    () => database.$disconnect(),
  )

  return composition
}
