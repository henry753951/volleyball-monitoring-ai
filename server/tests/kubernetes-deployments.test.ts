import { describe, expect, it } from 'vitest'
import { buildDeploymentSnapshot } from '../src/operations/kubernetes-deployments.js'

describe('Kubernetes deployment snapshot', () => {
  it('reports version, commit, deployed digest, resources, node, and accelerator', () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const snapshot = buildDeploymentSnapshot(
      'volleyball-monitoring',
      [
        {
          metadata: {
            name: 'analysis-worker',
            annotations: {
              'vollyai.hsulab.net/accelerator': 'NVIDIA H100 NVL',
              'vollyai.hsulab.net/component': 'analysis-worker',
              'vollyai.hsulab.net/display-name': 'AI Worker',
              'vollyai.hsulab.net/git-sha': '1234567890abcdef',
              'vollyai.hsulab.net/model-sha256': 'f45f96ce',
              'vollyai.hsulab.net/model-version': 'court-canonical-v4',
              'vollyai.hsulab.net/pod-label': 'volleyball-analysis-worker',
              'vollyai.hsulab.net/repository-url': 'https://github.com/example/engine',
              'vollyai.hsulab.net/version': '0.4.0',
            },
          },
          spec: {
            replicas: 1,
            template: {
              spec: {
                containers: [
                  {
                    image: `ghcr.io/example/engine:0.4.0@${digest}`,
                    name: 'analysis-worker',
                    resources: {
                      limits: { cpu: '16', memory: '64Gi', 'nvidia.com/gpu': '1' },
                      requests: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' },
                    },
                  },
                ],
              },
            },
          },
          status: { availableReplicas: 1, readyReplicas: 1, replicas: 1, updatedReplicas: 1 },
        },
      ],
      [
        {
          metadata: {
            labels: { 'app.kubernetes.io/name': 'volleyball-analysis-worker' },
            name: 'analysis-worker-1',
          },
          spec: { nodeName: 'k8s-worker-1' },
          status: {
            containerStatuses: [
              { imageID: `ghcr.io/example/engine@${digest}`, name: 'analysis-worker', ready: true },
            ],
            phase: 'Running',
          },
        },
      ],
    )

    expect(snapshot).toMatchObject({
      available: true,
      namespace: 'volleyball-monitoring',
      overallStatus: 'ready',
      source: 'kubernetes',
      components: [
        {
          accelerator: 'NVIDIA H100 NVL',
          component: 'analysis-worker',
          gitSha: '1234567890abcdef',
          imageDigest: digest,
          modelVersion: 'court-canonical-v4',
          nodeNames: ['k8s-worker-1'],
          status: 'ready',
          version: '0.4.0',
        },
      ],
    })
  })
})
