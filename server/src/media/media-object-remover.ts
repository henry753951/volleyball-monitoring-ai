import { Client, type ClientOptions } from 'minio'

export interface MediaObjectLocation {
  bucket: string
  objectKey: string
}
export type MediaObjectRemover = (location: MediaObjectLocation) => Promise<void>

function clientOptions(endpointValue: string, accessKey: string, secretKey: string): ClientOptions {
  const endpoint = new URL(endpointValue)
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname)
    throw new Error('MinIO endpoint is invalid')
  return {
    accessKey,
    endPoint: endpoint.hostname,
    pathStyle: true,
    port: endpoint.port
      ? Number.parseInt(endpoint.port, 10)
      : endpoint.protocol === 'https:'
        ? 443
        : 80,
    secretKey,
    useSSL: endpoint.protocol === 'https:',
  }
}

export function createMediaObjectRemoverFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): MediaObjectRemover | undefined {
  const endpoint = environment.MINIO_ENDPOINT
  const accessKey = environment.MINIO_ACCESS_KEY
  const secretKey = environment.MINIO_SECRET_KEY
  if (!endpoint && !accessKey && !secretKey) return undefined
  if (!endpoint || !accessKey || !secretKey)
    throw new Error('MinIO cleanup configuration is incomplete')
  const client = new Client(clientOptions(endpoint, accessKey, secretKey))
  return async ({ bucket, objectKey }) => {
    try {
      await client.removeObject(bucket, objectKey)
    } catch (error) {
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
      if (!['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(String(code ?? ''))) throw error
    }
  }
}
