import { readFile } from 'node:fs/promises'
import { request } from 'node:https'

const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount'
const DEFAULT_PART_OF = 'volleyball-monitoring-ai'

export type DeploymentStatus = 'degraded' | 'progressing' | 'ready' | 'unknown'

export interface DeploymentComponentSnapshot {
  accelerator: string | null
  availableReplicas: number
  component: string
  desiredImage: string
  desiredReplicas: number
  gitSha: string | null
  imageDigest: string | null
  limits: Record<string, string>
  modelSha256: string | null
  modelVersion: string | null
  name: string
  nodeNames: string[]
  readyReplicas: number
  repositoryUrl: string | null
  requests: Record<string, string>
  status: DeploymentStatus
  updatedReplicas: number
  version: string | null
}

export interface DeploymentSnapshot {
  available: boolean
  components: DeploymentComponentSnapshot[]
  namespace: string | null
  overallStatus: DeploymentStatus
  source: 'environment' | 'kubernetes' | 'unavailable'
}

export type DeploymentProbe = () => Promise<DeploymentSnapshot>

interface KubernetesDeployment {
  metadata?: {
    annotations?: Record<string, string>
    name?: string
  }
  spec?: {
    replicas?: number
    template?: {
      spec?: {
        containers?: Array<{
          image?: string
          name?: string
          resources?: {
            limits?: Record<string, string>
            requests?: Record<string, string>
          }
        }>
      }
    }
  }
  status?: {
    availableReplicas?: number
    readyReplicas?: number
    replicas?: number
    unavailableReplicas?: number
    updatedReplicas?: number
  }
}

interface KubernetesPod {
  metadata?: { labels?: Record<string, string>; name?: string }
  spec?: { nodeName?: string }
  status?: {
    containerStatuses?: Array<{
      imageID?: string
      name?: string
      ready?: boolean
    }>
    phase?: string
  }
}

interface KubernetesList<T> {
  items?: T[]
}

function deploymentStatus(
  desired: number,
  ready: number,
  updated: number,
  available: number,
): DeploymentStatus {
  if (desired === 0) return 'unknown'
  if (ready === desired && updated === desired && available === desired) return 'ready'
  if (ready > 0 || updated > 0) return 'progressing'
  return 'degraded'
}

function digestFromImageId(imageId: string | undefined) {
  if (!imageId) return null
  const digest = imageId.match(/sha256:[0-9a-f]{64}/i)?.[0]
  return digest?.toLowerCase() ?? null
}

function versionFromImage(image: string) {
  const withoutDigest = image.split('@', 1)[0] ?? image
  const slash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.lastIndexOf(':')
  return colon > slash ? withoutDigest.slice(colon + 1) : null
}

function overallStatus(components: DeploymentComponentSnapshot[]): DeploymentStatus {
  if (components.length === 0) return 'unknown'
  if (components.some(component => component.status === 'degraded')) return 'degraded'
  if (components.some(component => component.status !== 'ready')) return 'progressing'
  return 'ready'
}

export function buildDeploymentSnapshot(
  namespace: string,
  deployments: KubernetesDeployment[],
  pods: KubernetesPod[],
): DeploymentSnapshot {
  const components = deployments
    .map((deployment): DeploymentComponentSnapshot | null => {
      const name = deployment.metadata?.name
      const container = deployment.spec?.template?.spec?.containers?.[0]
      if (!name || !container?.image) return null
      const annotations = deployment.metadata?.annotations ?? {}
      const matchingPods = pods.filter(pod => pod.metadata?.labels?.['app.kubernetes.io/name'] === annotations['vollyai.hsulab.net/pod-label'])
      const desired = deployment.spec?.replicas ?? deployment.status?.replicas ?? 0
      const ready = deployment.status?.readyReplicas ?? 0
      const updated = deployment.status?.updatedReplicas ?? 0
      const available = deployment.status?.availableReplicas ?? 0
      const imageDigest = matchingPods
        .flatMap(pod => pod.status?.containerStatuses ?? [])
        .find(status => status.name === container.name)?.imageID
      return {
        accelerator: annotations['vollyai.hsulab.net/accelerator'] ?? null,
        availableReplicas: available,
        component: annotations['vollyai.hsulab.net/component'] ?? name,
        desiredImage: container.image,
        desiredReplicas: desired,
        gitSha: annotations['vollyai.hsulab.net/git-sha'] ?? null,
        imageDigest: digestFromImageId(imageDigest) ?? digestFromImageId(container.image),
        limits: container.resources?.limits ?? {},
        modelSha256: annotations['vollyai.hsulab.net/model-sha256'] ?? null,
        modelVersion: annotations['vollyai.hsulab.net/model-version'] ?? null,
        name: annotations['vollyai.hsulab.net/display-name'] ?? name,
        nodeNames: [...new Set(matchingPods.flatMap(pod => pod.spec?.nodeName ? [pod.spec.nodeName] : []))],
        readyReplicas: ready,
        repositoryUrl: annotations['vollyai.hsulab.net/repository-url'] ?? null,
        requests: container.resources?.requests ?? {},
        status: deploymentStatus(desired, ready, updated, available),
        updatedReplicas: updated,
        version: annotations['vollyai.hsulab.net/version'] ?? versionFromImage(container.image),
      }
    })
    .filter(component => component !== null)
    .sort((left, right) => left.component.localeCompare(right.component))
  return {
    available: true,
    components,
    namespace,
    overallStatus: overallStatus(components),
    source: 'kubernetes',
  }
}

function environmentSnapshot(env: NodeJS.ProcessEnv): DeploymentSnapshot {
  const image = env.APP_IMAGE ?? ''
  const version = env.APP_VERSION ?? versionFromImage(image)
  const component: DeploymentComponentSnapshot = {
    accelerator: null,
    availableReplicas: 1,
    component: env.APP_COMPONENT ?? 'server',
    desiredImage: image,
    desiredReplicas: 1,
    gitSha: env.APP_GIT_SHA ?? null,
    imageDigest: digestFromImageId(image),
    limits: {},
    modelSha256: null,
    modelVersion: null,
    name: env.APP_COMPONENT ?? 'server',
    nodeNames: [],
    readyReplicas: 1,
    repositoryUrl: env.APP_REPOSITORY_URL ?? null,
    requests: {},
    status: 'ready',
    updatedReplicas: 1,
    version,
  }
  return {
    available: Boolean(version || component.gitSha || image),
    components: version || component.gitSha || image ? [component] : [],
    namespace: null,
    overallStatus: version || component.gitSha || image ? 'ready' : 'unknown',
    source: version || component.gitSha || image ? 'environment' : 'unavailable',
  }
}

function kubernetesJson<T>(
  host: string,
  port: number,
  path: string,
  token: string,
  ca: Buffer,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({
      ca,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      host,
      method: 'GET',
      path,
      port,
      rejectUnauthorized: true,
      timeout: 3_000,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Kubernetes API returned ${response.statusCode ?? 'unknown'}: ${body.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(body) as T)
        }
        catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Kubernetes API request timed out')))
    req.end()
  })
}

export function createKubernetesDeploymentProbe(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentProbe {
  const host = env.KUBERNETES_SERVICE_HOST
  const port = Number(env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? 443)
  if (!host || !Number.isFinite(port)) return async () => environmentSnapshot(env)
  return async () => {
    try {
      const [namespace, token, ca] = await Promise.all([
        readFile(`${SERVICE_ACCOUNT_ROOT}/namespace`, 'utf8'),
        readFile(`${SERVICE_ACCOUNT_ROOT}/token`, 'utf8'),
        readFile(`${SERVICE_ACCOUNT_ROOT}/ca.crt`),
      ])
      const normalizedNamespace = namespace.trim()
      const selector = encodeURIComponent(`app.kubernetes.io/part-of=${env.APP_KUBERNETES_PART_OF ?? DEFAULT_PART_OF}`)
      const [deploymentList, podList] = await Promise.all([
        kubernetesJson<KubernetesList<KubernetesDeployment>>(
          host,
          port,
          `/apis/apps/v1/namespaces/${normalizedNamespace}/deployments?labelSelector=${selector}`,
          token.trim(),
          ca,
        ),
        kubernetesJson<KubernetesList<KubernetesPod>>(
          host,
          port,
          `/api/v1/namespaces/${normalizedNamespace}/pods?labelSelector=${selector}`,
          token.trim(),
          ca,
        ),
      ])
      return buildDeploymentSnapshot(normalizedNamespace, deploymentList.items ?? [], podList.items ?? [])
    }
    catch {
      return environmentSnapshot(env)
    }
  }
}
