import { db } from '@volleyball-monitoring/db'
import { parseSampleIndexDocument } from '@volleyball-monitoring/media'
import { Client } from 'minio'
import { projectPlaybackFragmentRanges } from './media/ingest-handler.js'
import { scanStoredMediaFragments } from './media/playback-fragment-index.js'

const MAX_MEDIA_BYTES = 512 * 1024 * 1024
const MAX_SAMPLE_INDEX_BYTES = 64 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function readObject(
  client: Client,
  bucket: string,
  objectKey: string,
  maximumBytes: number,
): Promise<Buffer> {
  const stream = await client.getObject(bucket, objectKey)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maximumBytes) {
      stream.destroy()
      throw new Error('media object exceeds the backfill limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

function fragmentCount(value: unknown): bigint {
  return Array.isArray(value) && value.length > 0 ? BigInt(value.length) : 1n
}

function serializedFragments(
  fragments: readonly { byteOffset: bigint; byteLength: bigint; durationUs: bigint }[],
) {
  return fragments.map(fragment => ({
    byte_offset: fragment.byteOffset.toString(),
    byte_length: fragment.byteLength.toString(),
    duration_us: fragment.durationUs.toString(),
  }))
}

async function main() {
  const apply = process.argv.includes('--apply')
  const matchId = argument('--match-id')
  if (matchId && !UUID.test(matchId)) throw new Error('--match-id must be a UUID')
  if (!matchId && !process.argv.includes('--all'))
    throw new Error('pass --match-id <uuid> or explicitly pass --all')

  const endpoint = new URL(requiredEnvironment('MINIO_ENDPOINT'))
  const client = new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnvironment('MINIO_ACCESS_KEY'),
    secretKey: requiredEnvironment('MINIO_SECRET_KEY'),
  })
  const programs = await db.dvrProgram.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      segments: {
        orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }],
        select: {
          captureEpoch: {
            select: {
              captureFrameOrigin: true,
              captureTimeOriginUs: true,
              id: true,
              sourcePtsOrigin: true,
              sourceTimeBaseDen: true,
              sourceTimeBaseNum: true,
            },
          },
          durationUs: true,
          id: true,
          isGap: true,
          mediaAsset: { select: { bucket: true, byteLength: true, objectKey: true } },
          playbackFragments: true,
          sampleIndexAsset: { select: { bucket: true, objectKey: true } },
          sequenceNumber: true,
        },
      },
    },
    where: matchId ? { captureSession: { matchId } } : {},
  })

  let projectedTotal = 0
  let fallbackTotal = 0
  let updatedTotal = 0
  for (const program of programs) {
    let playbackSequenceStart = 0n
    let projected = 0
    let fallback = 0
    for (const segment of program.segments) {
      let projection: ReturnType<typeof serializedFragments> | null = null
      try {
        if (
          !segment.isGap &&
          segment.mediaAsset?.byteLength &&
          segment.mediaAsset.byteLength > 0n &&
          segment.sampleIndexAsset
        ) {
          const [mediaBytes, sampleIndexBytes] = await Promise.all([
            readObject(
              client,
              segment.mediaAsset.bucket,
              segment.mediaAsset.objectKey,
              MAX_MEDIA_BYTES,
            ),
            readObject(
              client,
              segment.sampleIndexAsset.bucket,
              segment.sampleIndexAsset.objectKey,
              MAX_SAMPLE_INDEX_BYTES,
            ),
          ])
          if (BigInt(mediaBytes.byteLength) !== segment.mediaAsset.byteLength)
            throw new Error('media object length does not match catalog metadata')
          const epoch = segment.captureEpoch
          const index = parseSampleIndexDocument(JSON.parse(sampleIndexBytes.toString('utf8')), {
            epochId: epoch.id,
            sourcePtsOrigin: epoch.sourcePtsOrigin,
            captureTimeOriginUs: epoch.captureTimeOriginUs,
            captureFrameOrigin: epoch.captureFrameOrigin,
            timeBase: {
              num: BigInt(epoch.sourceTimeBaseNum),
              den: BigInt(epoch.sourceTimeBaseDen),
            },
          })
          const ranges = scanStoredMediaFragments(mediaBytes)
          const fragments = projectPlaybackFragmentRanges(
            ranges,
            segment.mediaAsset.byteLength,
            index.samples,
            index.timeBase,
          )
          if (!fragments) throw new Error('fragment and keyframe layouts do not match')
          if (
            fragments.reduce((sum, fragment) => sum + fragment.durationUs, 0n) !==
            segment.durationUs
          )
            throw new Error('fragment duration does not match the catalog segment')
          projection = serializedFragments(fragments)
        }
      } catch (error) {
        console.warn(
          `segment=${segment.id} sequence=${segment.sequenceNumber} fallback=${error instanceof Error ? error.message : 'unknown'}`,
        )
      }

      const persistedCount = fragmentCount(segment.playbackFragments)
      const count = projection ? BigInt(projection.length) : persistedCount
      if (projection) projected += 1
      else fallback += 1
      if (apply) {
        await db.dvrSegment.update({
          data: {
            playbackSequenceStart,
            ...(projection ? { playbackFragments: projection } : {}),
          },
          where: { id: segment.id },
        })
        updatedTotal += 1
      }
      playbackSequenceStart += count
    }
    projectedTotal += projected
    fallbackTotal += fallback
    console.log(
      `program=${program.id} segments=${program.segments.length} projected=${projected} fallback=${fallback} next_sequence=${playbackSequenceStart}`,
    )
  }
  console.log(
    `mode=${apply ? 'apply' : 'dry-run'} programs=${programs.length} projected=${projectedTotal} fallback=${fallbackTotal} updated=${updatedTotal}`,
  )
}

try {
  await main()
} finally {
  await db.$disconnect()
}
