import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Client } from 'minio'

export type WorkflowMinio = { client: Client; rallyBucket: string; analysisBucket: string }

export function createWorkflowMinio(): WorkflowMinio {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required')
  return {
    client: new Client({
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
      useSSL: endpoint.protocol === 'https:',
      accessKey,
      secretKey,
      pathStyle: true,
    }),
    rallyBucket: process.env.MINIO_RALLY_BUCKET ?? 'rally-media',
    analysisBucket: process.env.MINIO_ANALYSIS_BUCKET ?? 'analysis-artifacts',
  }
}

async function hotObjectPath(asset: { bucket: string; objectKey: string }): Promise<string | null> {
  const rootValue = process.env.MEDIA_HOT_ROOT?.trim()
  if (!rootValue) return null
  if (
    !asset.bucket ||
    asset.bucket.includes('/') ||
    asset.bucket.includes('\\') ||
    !asset.objectKey ||
    asset.objectKey.startsWith('/') ||
    asset.objectKey.includes('\\') ||
    asset.objectKey.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('source media asset location is invalid')
  }
  const root = resolve(rootValue)
  const path = resolve(root, asset.bucket, ...asset.objectKey.split('/'))
  const relation = relative(root, path)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('source media asset escapes the hot storage root')
  }
  try {
    const metadata = await stat(path)
    return metadata.isFile() ? path : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function appendVerifiedObject(
  client: Client,
  asset: { bucket: string; objectKey: string; byteLength: bigint | null; sha256: string | null },
  destination: string,
): Promise<void> {
  if (asset.byteLength === null || asset.sha256 === null)
    throw new Error('source media asset metadata is incomplete')
  const hotPath = await hotObjectPath(asset)
  const source = hotPath
    ? createReadStream(hotPath)
    : await client.getObject(asset.bucket, asset.objectKey)
  const digest = createHash('sha256')
  let bytes = 0n
  source.on('data', (chunk: Buffer) => {
    digest.update(chunk)
    bytes += BigInt(chunk.byteLength)
  })
  await pipeline(source, createWriteStream(destination, { flags: 'a' }))
  if (bytes !== asset.byteLength || digest.digest('hex') !== asset.sha256)
    throw new Error('source media asset verification failed')
}

export async function readVerifiedObject(
  client: Client,
  asset: { bucket: string; objectKey: string; byteLength: bigint | null; sha256: string | null },
  maxBytes = 64n * 1024n * 1024n,
): Promise<Buffer> {
  if (asset.byteLength === null || asset.sha256 === null)
    throw new Error('source media asset metadata is incomplete')
  if (asset.byteLength < 0n || asset.byteLength > maxBytes)
    throw new Error('source media asset exceeds the bounded read limit')
  const hotPath = await hotObjectPath(asset)
  const source = hotPath
    ? createReadStream(hotPath)
    : await client.getObject(asset.bucket, asset.objectKey)
  const digest = createHash('sha256')
  const chunks: Buffer[] = []
  let bytes = 0n
  for await (const value of source) {
    const chunk = Buffer.from(value as Uint8Array)
    bytes += BigInt(chunk.byteLength)
    if (bytes > maxBytes || bytes > asset.byteLength)
      throw new Error('source media asset exceeds its verified length')
    digest.update(chunk)
    chunks.push(chunk)
  }
  if (bytes !== asset.byteLength || digest.digest('hex') !== asset.sha256)
    throw new Error('source media asset verification failed')
  return Buffer.concat(chunks)
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

export async function putVerifiedBuffer(
  client: Client,
  bucket: string,
  objectKey: string,
  value: Buffer,
  contentType: string,
  extraMetadata: Record<string, string> = {},
) {
  const sha256 = createHash('sha256').update(value).digest('hex')
  await client.putObject(bucket, objectKey, value, value.byteLength, {
    'Content-Type': contentType,
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-byte-length': String(value.byteLength),
    ...extraMetadata,
  })
  return { sha256, byteLength: BigInt(value.byteLength) }
}
