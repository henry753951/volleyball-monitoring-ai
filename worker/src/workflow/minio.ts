import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Client } from 'minio'

export type WorkflowMinio = { client: Client; rallyBucket: string; analysisBucket: string }

export function createWorkflowMinio(): WorkflowMinio {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required')
  return {
    client: new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', accessKey, secretKey, pathStyle: true }),
    rallyBucket: process.env.MINIO_RALLY_BUCKET ?? 'rally-media',
    analysisBucket: process.env.MINIO_ANALYSIS_BUCKET ?? 'analysis-artifacts',
  }
}

export async function appendVerifiedObject(
  client: Client,
  asset: { bucket: string; objectKey: string; byteLength: bigint | null; sha256: string | null },
  destination: string,
): Promise<void> {
  if (asset.byteLength === null || asset.sha256 === null) throw new Error('source media asset metadata is incomplete')
  const source = await client.getObject(asset.bucket, asset.objectKey)
  const digest = createHash('sha256')
  let bytes = 0n
  source.on('data', (chunk: Buffer) => { digest.update(chunk); bytes += BigInt(chunk.byteLength) })
  await pipeline(source, createWriteStream(destination, { flags: 'a' }))
  if (bytes !== asset.byteLength || digest.digest('hex') !== asset.sha256) throw new Error('source media asset verification failed')
}

export async function uploadFile(
  client: Client,
  bucket: string,
  objectKey: string,
  filePath: string,
  contentType: string,
  extraMetadata: Record<string, string> = {},
) {
  const digest = createHash('sha256')
  const input = createReadStream(filePath)
  for await (const chunk of input) digest.update(chunk as Buffer)
  const info = await stat(filePath)
  const sha256 = digest.digest('hex')
  await client.putObject(bucket, objectKey, createReadStream(filePath), info.size, {
    'Content-Type': contentType,
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-byte-length': String(info.size),
    ...extraMetadata,
  })
  return { sha256, byteLength: BigInt(info.size) }
}
