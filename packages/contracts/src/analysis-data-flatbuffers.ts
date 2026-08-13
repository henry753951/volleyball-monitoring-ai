import { Builder, ByteBuffer, type Offset } from 'flatbuffers'

export const ANALYSIS_DATA_IDENTIFIER = 'VAD1'
export const ANALYSIS_FRAME_CHUNK_IDENTIFIER = 'VFC1'
export const ANALYSIS_PLAYER_FLAG = { frameBBox: 1, frameFootPosition: 2, courtPosition: 4 } as const
export const ANALYSIS_BALL_FLAG = { framePosition: 1 } as const
export const ANALYSIS_MISSING_ACTION_LABEL = 65_535
export const ANALYSIS_MISSING_CONFIDENCE = 255

export interface AnalysisDataFrameBBox { x1: number; y1: number; x2: number; y2: number }
export interface AnalysisFramePosition { x: number; y: number }
export interface AnalysisCourtPosition { x: number; y: number }

export interface AnalysisData {
  schemaVersion: number
  aiJobId: string
  rallySubmissionId: string
  rallyId: string
  matchId: string
  annotationRevision: bigint
  clipAssetId: string
  analysisId: string
  analysisVersion: string
  videoWidth: number
  videoHeight: number
  fpsNum: number
  fpsDen: number
  totalFrames: bigint
  frameOffsets: number[]
  trackIds: number[]
  frameBboxes: AnalysisDataFrameBBox[]
  frameFootPositions: AnalysisFramePosition[]
  courtPositions: AnalysisCourtPosition[]
  playerFlags: number[]
  playerConfidences: number[]
  actionTaxonomyId: string
  actionTaxonomyVersion: string
  actionLabels: string[]
  actionLabelIds: number[]
  actionConfidences: number[]
  ballFramePositions: AnalysisFramePosition[]
  ballFlags: number[]
  ballConfidences: number[]
  courtKeypointFrameOffsets: number[]
  courtKeypointIds: number[]
  courtKeypointPositions: AnalysisFramePosition[]
  courtKeypointConfidences: number[]
  domainJson: string
  inputClipSha256: string
  producerName: string
  producerBuildId: string
  producerSdkVersion: string
  executionManifestJson: string
}

export interface AnalysisFrameChunk {
  schemaVersion: number
  analysisId: string
  analysisDataVersion: string
  chunkIndex: number
  startFrameIndex: bigint
  frameCount: number
  frameOffsets: number[]
  trackIds: number[]
  frameBboxes: AnalysisDataFrameBBox[]
  frameFootPositions: AnalysisFramePosition[]
  courtPositions: AnalysisCourtPosition[]
  playerFlags: number[]
  playerConfidences: number[]
  actionLabelIds: number[]
  actionConfidences: number[]
  ballFramePositions: AnalysisFramePosition[]
  ballFlags: number[]
  ballConfidences: number[]
  courtKeypointFrameOffsets: number[]
  courtKeypointIds: number[]
  courtKeypointPositions: AnalysisFramePosition[]
  courtKeypointConfidences: number[]
}

function root(bytes: Uint8Array, identifier: string) {
  const bb = new ByteBuffer(bytes)
  if (!bb.__has_identifier(identifier)) throw new TypeError(`FlatBuffer identifier must be ${identifier}`)
  const position = bb.position()
  const table = position + bb.readInt32(position)
  if (table < 8 || table + 4 > bb.capacity()) throw new TypeError('FlatBuffer root table is out of bounds')
  return { bb, table }
}

function field(bb: ByteBuffer, table: number, index: number) {
  const relative = bb.__offset(table, 4 + index * 2)
  return relative ? table + relative : 0
}

function stringField(bb: ByteBuffer, table: number, index: number) {
  const offset = field(bb, table, index)
  return offset ? String(bb.__string(offset)) : ''
}

function u8(bb: ByteBuffer, table: number, index: number, fallback = 0) { const offset = field(bb, table, index); return offset ? bb.readUint8(offset) : fallback }
function u32(bb: ByteBuffer, table: number, index: number, fallback = 0) { const offset = field(bb, table, index); return offset ? bb.readUint32(offset) : fallback }
function u64(bb: ByteBuffer, table: number, index: number, fallback = 0n) { const offset = field(bb, table, index); return offset ? bb.readUint64(offset) : fallback }

function vector(bb: ByteBuffer, table: number, index: number) {
  const offset = field(bb, table, index)
  return offset ? { start: bb.__vector(offset), length: bb.__vector_len(offset) } : { start: 0, length: 0 }
}

function scalarVector(bb: ByteBuffer, table: number, index: number, width: 1 | 2 | 4) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => width === 1 ? bb.readUint8(value.start + item) : width === 2 ? bb.readUint16(value.start + item * 2) : bb.readUint32(value.start + item * 4))
}

function bboxVector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => {
    const start = value.start + item * 8
    return { x1: bb.readUint16(start), y1: bb.readUint16(start + 2), x2: bb.readUint16(start + 4), y2: bb.readUint16(start + 6) }
  })
}

function framePositionVector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => {
    const start = value.start + item * 4
    return { x: bb.readUint16(start), y: bb.readUint16(start + 2) }
  })
}

function courtPositionVector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => {
    const start = value.start + item * 8
    return { x: bb.readFloat32(start), y: bb.readFloat32(start + 4) }
  })
}

function stringVector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => String(bb.__string(value.start + item * 4)))
}

function validateColumns(input: {
  totalFrames: bigint
  frameOffsets: number[]
  trackIds: number[]
  frameBboxes: unknown[]
  frameFootPositions: unknown[]
  courtPositions: unknown[]
  playerFlags: number[]
  playerConfidences: number[]
  actionLabelIds: number[]
  actionConfidences: number[]
  ballFramePositions: unknown[]
  ballFlags: number[]
  ballConfidences: number[]
  courtKeypointFrameOffsets: number[]
  courtKeypointIds: number[]
  courtKeypointPositions: unknown[]
  courtKeypointConfidences: number[]
}) {
  if (input.totalFrames < 0n || input.totalFrames > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('analysis data total_frames is outside the supported range')
  const frameCount = Number(input.totalFrames)
  if (frameCount === 0 && input.frameOffsets.length === 0) input.frameOffsets.push(0)
  if (input.frameOffsets.length !== frameCount + 1 || input.frameOffsets[0] !== 0) throw new TypeError('analysis data frame_offsets must contain frame_count + 1 entries and begin at zero')
  for (let index = 1; index < input.frameOffsets.length; index += 1) if (input.frameOffsets[index]! < input.frameOffsets[index - 1]!) throw new TypeError('analysis data frame_offsets must be monotonic')
  const detections = input.frameOffsets.at(-1) ?? 0
  for (const [name, column] of Object.entries({ trackIds: input.trackIds, frameBboxes: input.frameBboxes, frameFootPositions: input.frameFootPositions, courtPositions: input.courtPositions, playerFlags: input.playerFlags, playerConfidences: input.playerConfidences, actionLabelIds: input.actionLabelIds, actionConfidences: input.actionConfidences })) {
    if (column.length !== detections) throw new TypeError(`analysis data ${name} length does not match detection count`)
  }
  for (const [name, column] of Object.entries({ ballFramePositions: input.ballFramePositions, ballFlags: input.ballFlags, ballConfidences: input.ballConfidences })) {
    if (column.length !== frameCount) throw new TypeError(`analysis data ${name} length does not match frame count`)
  }
  if (input.courtKeypointFrameOffsets.length === 0) input.courtKeypointFrameOffsets.push(...Array.from({ length: frameCount + 1 }, () => 0))
  if (input.courtKeypointFrameOffsets.length !== frameCount + 1 || input.courtKeypointFrameOffsets[0] !== 0) throw new TypeError('analysis data courtKeypointFrameOffsets must contain frame_count + 1 entries and begin at zero')
  for (let index = 1; index < input.courtKeypointFrameOffsets.length; index += 1) if (input.courtKeypointFrameOffsets[index]! < input.courtKeypointFrameOffsets[index - 1]!) throw new TypeError('analysis data courtKeypointFrameOffsets must be monotonic')
  const courtKeypoints = input.courtKeypointFrameOffsets.at(-1) ?? 0
  for (const [name, column] of Object.entries({ courtKeypointIds: input.courtKeypointIds, courtKeypointPositions: input.courtKeypointPositions, courtKeypointConfidences: input.courtKeypointConfidences })) {
    if (column.length !== courtKeypoints) throw new TypeError(`analysis data ${name} length does not match court keypoint count`)
  }
}

export function parseAnalysisData(bytes: Uint8Array): AnalysisData {
  const { bb, table } = root(bytes, ANALYSIS_DATA_IDENTIFIER)
  const result: AnalysisData = {
    schemaVersion: u32(bb, table, 0, 10_000),
    aiJobId: stringField(bb, table, 1), rallySubmissionId: stringField(bb, table, 2), rallyId: stringField(bb, table, 3), matchId: stringField(bb, table, 4), annotationRevision: u64(bb, table, 5), clipAssetId: stringField(bb, table, 6), analysisId: stringField(bb, table, 7), analysisVersion: stringField(bb, table, 8),
    videoWidth: u32(bb, table, 9), videoHeight: u32(bb, table, 10), fpsNum: u32(bb, table, 11), fpsDen: u32(bb, table, 12), totalFrames: u64(bb, table, 13),
    frameOffsets: scalarVector(bb, table, 15, 4), trackIds: scalarVector(bb, table, 16, 2), frameBboxes: bboxVector(bb, table, 17), frameFootPositions: framePositionVector(bb, table, 18), courtPositions: courtPositionVector(bb, table, 19), playerFlags: scalarVector(bb, table, 20, 1), playerConfidences: scalarVector(bb, table, 21, 1),
    actionTaxonomyId: stringField(bb, table, 22), actionTaxonomyVersion: stringField(bb, table, 23), actionLabels: stringVector(bb, table, 24), actionLabelIds: scalarVector(bb, table, 25, 2), actionConfidences: scalarVector(bb, table, 26, 1),
    ballFramePositions: framePositionVector(bb, table, 27), ballFlags: scalarVector(bb, table, 28, 1), ballConfidences: scalarVector(bb, table, 29, 1),
    courtKeypointFrameOffsets: scalarVector(bb, table, 30, 4), courtKeypointIds: scalarVector(bb, table, 31, 2), courtKeypointPositions: framePositionVector(bb, table, 32), courtKeypointConfidences: scalarVector(bb, table, 33, 1),
    domainJson: stringField(bb, table, 34), inputClipSha256: stringField(bb, table, 35), producerName: stringField(bb, table, 36), producerBuildId: stringField(bb, table, 37), producerSdkVersion: stringField(bb, table, 38), executionManifestJson: stringField(bb, table, 39),
  }
  if (result.schemaVersion !== 10_000) throw new TypeError('AnalysisData schema_version is unsupported')
  if (!result.domainJson || !result.inputClipSha256 || !result.producerName || !result.producerBuildId) throw new TypeError('AnalysisData metadata is incomplete')
  validateColumns(result)
  return result
}

function intVector(builder: Builder, values: readonly number[], width: 1 | 2 | 4): Offset {
  builder.startVector(width, values.length, width)
  for (let index = values.length - 1; index >= 0; index -= 1) width === 1 ? builder.addInt8(values[index]!) : width === 2 ? builder.addInt16(values[index]!) : builder.addInt32(values[index]!)
  return builder.endVector()
}

function bboxesVector(builder: Builder, values: readonly AnalysisDataFrameBBox[]): Offset {
  builder.startVector(8, values.length, 2)
  for (let index = values.length - 1; index >= 0; index -= 1) { const value = values[index]!; builder.prep(2, 8); builder.writeInt16(value.y2); builder.writeInt16(value.x2); builder.writeInt16(value.y1); builder.writeInt16(value.x1) }
  return builder.endVector()
}

function framePositionsVector(builder: Builder, values: readonly AnalysisFramePosition[]): Offset {
  builder.startVector(4, values.length, 2)
  for (let index = values.length - 1; index >= 0; index -= 1) { const value = values[index]!; builder.prep(2, 4); builder.writeInt16(value.y); builder.writeInt16(value.x) }
  return builder.endVector()
}

function courtPositionsVector(builder: Builder, values: readonly AnalysisCourtPosition[]): Offset {
  builder.startVector(8, values.length, 4)
  for (let index = values.length - 1; index >= 0; index -= 1) { const value = values[index]!; builder.prep(4, 8); builder.writeFloat32(value.y); builder.writeFloat32(value.x) }
  return builder.endVector()
}

export function encodeAnalysisFrameChunk(input: AnalysisFrameChunk): Uint8Array {
  validateColumns({ ...input, totalFrames: BigInt(input.frameCount) })
  const builder = new Builder(Math.max(1024, input.trackIds.length * 48))
  const analysisId = builder.createString(input.analysisId)
  const analysisDataVersion = builder.createString(input.analysisDataVersion)
  const frameOffsets = intVector(builder, input.frameOffsets, 4)
  const trackIds = intVector(builder, input.trackIds, 2)
  const frameBboxes = bboxesVector(builder, input.frameBboxes)
  const frameFootPositions = framePositionsVector(builder, input.frameFootPositions)
  const courtPositions = courtPositionsVector(builder, input.courtPositions)
  const playerFlags = intVector(builder, input.playerFlags, 1)
  const playerConfidences = intVector(builder, input.playerConfidences, 1)
  const actionLabelIds = intVector(builder, input.actionLabelIds, 2)
  const actionConfidences = intVector(builder, input.actionConfidences, 1)
  const ballFramePositions = framePositionsVector(builder, input.ballFramePositions)
  const ballFlags = intVector(builder, input.ballFlags, 1)
  const ballConfidences = intVector(builder, input.ballConfidences, 1)
  const courtKeypointFrameOffsets = intVector(builder, input.courtKeypointFrameOffsets, 4)
  const courtKeypointIds = intVector(builder, input.courtKeypointIds, 2)
  const courtKeypointPositions = framePositionsVector(builder, input.courtKeypointPositions)
  const courtKeypointConfidences = intVector(builder, input.courtKeypointConfidences, 1)
  builder.startObject(22)
  builder.addFieldInt32(0, input.schemaVersion, 10_000)
  builder.addFieldOffset(1, analysisId, 0)
  builder.addFieldOffset(2, analysisDataVersion, 0)
  builder.addFieldInt32(3, input.chunkIndex, 0)
  builder.addFieldInt64(4, input.startFrameIndex, 0n)
  builder.addFieldInt32(5, input.frameCount, 0)
  builder.addFieldOffset(6, frameOffsets, 0); builder.addFieldOffset(7, trackIds, 0); builder.addFieldOffset(8, frameBboxes, 0); builder.addFieldOffset(9, frameFootPositions, 0); builder.addFieldOffset(10, courtPositions, 0); builder.addFieldOffset(11, playerFlags, 0); builder.addFieldOffset(12, playerConfidences, 0); builder.addFieldOffset(13, actionLabelIds, 0); builder.addFieldOffset(14, actionConfidences, 0); builder.addFieldOffset(15, ballFramePositions, 0); builder.addFieldOffset(16, ballFlags, 0); builder.addFieldOffset(17, ballConfidences, 0)
  builder.addFieldOffset(18, courtKeypointFrameOffsets, 0); builder.addFieldOffset(19, courtKeypointIds, 0); builder.addFieldOffset(20, courtKeypointPositions, 0); builder.addFieldOffset(21, courtKeypointConfidences, 0)
  const result = builder.endObject()
  builder.finish(result, ANALYSIS_FRAME_CHUNK_IDENTIFIER)
  return builder.asUint8Array()
}

export function parseAnalysisFrameChunk(bytes: Uint8Array): AnalysisFrameChunk {
  const { bb, table } = root(bytes, ANALYSIS_FRAME_CHUNK_IDENTIFIER)
  const result: AnalysisFrameChunk = {
    schemaVersion: u32(bb, table, 0, 10_000), analysisId: stringField(bb, table, 1), analysisDataVersion: stringField(bb, table, 2), chunkIndex: u32(bb, table, 3), startFrameIndex: u64(bb, table, 4), frameCount: u32(bb, table, 5),
    frameOffsets: scalarVector(bb, table, 6, 4), trackIds: scalarVector(bb, table, 7, 2), frameBboxes: bboxVector(bb, table, 8), frameFootPositions: framePositionVector(bb, table, 9), courtPositions: courtPositionVector(bb, table, 10), playerFlags: scalarVector(bb, table, 11, 1), playerConfidences: scalarVector(bb, table, 12, 1), actionLabelIds: scalarVector(bb, table, 13, 2), actionConfidences: scalarVector(bb, table, 14, 1), ballFramePositions: framePositionVector(bb, table, 15), ballFlags: scalarVector(bb, table, 16, 1), ballConfidences: scalarVector(bb, table, 17, 1),
    courtKeypointFrameOffsets: scalarVector(bb, table, 18, 4), courtKeypointIds: scalarVector(bb, table, 19, 2), courtKeypointPositions: framePositionVector(bb, table, 20), courtKeypointConfidences: scalarVector(bb, table, 21, 1),
  }
  if (result.schemaVersion !== 10_000) throw new TypeError('browser analysis frame chunk schema_version is unsupported')
  validateColumns({ ...result, totalFrames: BigInt(result.frameCount) })
  return result
}

export function chunkAnalysisData(sequence: AnalysisData, chunkFrameCount = 120): AnalysisFrameChunk[] {
  if (!Number.isSafeInteger(chunkFrameCount) || chunkFrameCount < 1) throw new RangeError('chunkFrameCount must be a positive safe integer')
  const totalFrames = Number(sequence.totalFrames)
  const chunks: AnalysisFrameChunk[] = []
  for (let start = 0, chunkIndex = 0; start < totalFrames; start += chunkFrameCount, chunkIndex += 1) {
    const frameCount = Math.min(chunkFrameCount, totalFrames - start)
    const detectionStart = sequence.frameOffsets[start]!
    const detectionEnd = sequence.frameOffsets[start + frameCount]!
    const courtKeypointStart = sequence.courtKeypointFrameOffsets[start]!
    const courtKeypointEnd = sequence.courtKeypointFrameOffsets[start + frameCount]!
    chunks.push({
      schemaVersion: 10_000, analysisId: sequence.analysisId, analysisDataVersion: '1', chunkIndex, startFrameIndex: BigInt(start), frameCount,
      frameOffsets: sequence.frameOffsets.slice(start, start + frameCount + 1).map(value => value - detectionStart),
      trackIds: sequence.trackIds.slice(detectionStart, detectionEnd), frameBboxes: sequence.frameBboxes.slice(detectionStart, detectionEnd), frameFootPositions: sequence.frameFootPositions.slice(detectionStart, detectionEnd), courtPositions: sequence.courtPositions.slice(detectionStart, detectionEnd), playerFlags: sequence.playerFlags.slice(detectionStart, detectionEnd), playerConfidences: sequence.playerConfidences.slice(detectionStart, detectionEnd), actionLabelIds: sequence.actionLabelIds.slice(detectionStart, detectionEnd), actionConfidences: sequence.actionConfidences.slice(detectionStart, detectionEnd),
      ballFramePositions: sequence.ballFramePositions.slice(start, start + frameCount), ballFlags: sequence.ballFlags.slice(start, start + frameCount), ballConfidences: sequence.ballConfidences.slice(start, start + frameCount),
      courtKeypointFrameOffsets: sequence.courtKeypointFrameOffsets.slice(start, start + frameCount + 1).map(value => value - courtKeypointStart), courtKeypointIds: sequence.courtKeypointIds.slice(courtKeypointStart, courtKeypointEnd), courtKeypointPositions: sequence.courtKeypointPositions.slice(courtKeypointStart, courtKeypointEnd), courtKeypointConfidences: sequence.courtKeypointConfidences.slice(courtKeypointStart, courtKeypointEnd),
    })
  }
  return chunks
}
