import { Builder, ByteBuffer, type Offset } from 'flatbuffers'

export const PERSON_POSE_EVIDENCE_IDENTIFIER = 'VPE1'
export const PERSON_POSE_KEYPOINT_COUNT = 17
export const PERSON_POSE_OBSERVATION_HASH_BYTES = 32

export const PERSON_POSE_STATUS = {
  available: 0,
  noUsableBbox: 1,
  inferenceFailed: 2,
  lowQuality: 3,
} as const

export const PERSON_POSE_BBOX_SOURCE = {
  detector: 0,
  trackerPropagated: 1,
} as const

export type PersonPoseObservationStatus =
  (typeof PERSON_POSE_STATUS)[keyof typeof PERSON_POSE_STATUS]
export type PersonPoseBboxSource =
  (typeof PERSON_POSE_BBOX_SOURCE)[keyof typeof PERSON_POSE_BBOX_SOURCE]

export interface PersonPoseEvidenceChunk {
  schemaVersion: string
  analysisRunId: string
  poseRecipeNamespace: string
  startFrameIndex: bigint
  frameCount: number
  frameOffsets: number[]
  trackIds: number[]
  bboxSources: PersonPoseBboxSource[]
  bboxX1: number[]
  bboxY1: number[]
  bboxX2: number[]
  bboxY2: number[]
  cropScaleX: number[]
  cropScaleY: number[]
  cropOffsetX: number[]
  cropOffsetY: number[]
  statuses: PersonPoseObservationStatus[]
  observationSha256: number[]
  keypointX: number[]
  keypointY: number[]
  keypointConfidence: number[]
}

function root(bytes: Uint8Array) {
  const bb = new ByteBuffer(bytes)
  if (!bb.__has_identifier(PERSON_POSE_EVIDENCE_IDENTIFIER))
    throw new TypeError(`FlatBuffer identifier must be ${PERSON_POSE_EVIDENCE_IDENTIFIER}`)
  const position = bb.position()
  const table = position + bb.readInt32(position)
  if (table < 8 || table + 4 > bb.capacity())
    throw new TypeError('person pose evidence root table is out of bounds')
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

function u32(bb: ByteBuffer, table: number, index: number, fallback = 0) {
  const offset = field(bb, table, index)
  return offset ? bb.readUint32(offset) : fallback
}

function u64(bb: ByteBuffer, table: number, index: number, fallback = 0n) {
  const offset = field(bb, table, index)
  return offset ? bb.readUint64(offset) : fallback
}

function vector(bb: ByteBuffer, table: number, index: number) {
  const offset = field(bb, table, index)
  return offset
    ? { start: bb.__vector(offset), length: bb.__vector_len(offset) }
    : { start: 0, length: 0 }
}

function u8Vector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => bb.readUint8(value.start + item))
}

function i32Vector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => bb.readInt32(value.start + item * 4))
}

function u32Vector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => bb.readUint32(value.start + item * 4))
}

function f32Vector(bb: ByteBuffer, table: number, index: number) {
  const value = vector(bb, table, index)
  return Array.from({ length: value.length }, (_, item) => bb.readFloat32(value.start + item * 4))
}

function validate(input: PersonPoseEvidenceChunk) {
  if (input.schemaVersion !== '1.0.0')
    throw new TypeError('person pose evidence schema_version is unsupported')
  if (!input.analysisRunId || !input.poseRecipeNamespace)
    throw new TypeError('person pose evidence metadata is incomplete')
  if (input.startFrameIndex < 0n || input.startFrameIndex > BigInt(Number.MAX_SAFE_INTEGER))
    throw new TypeError('person pose evidence start frame is outside the supported range')
  if (!Number.isSafeInteger(input.frameCount) || input.frameCount < 1)
    throw new TypeError('person pose evidence frame count is invalid')
  if (input.frameOffsets.length !== input.frameCount + 1 || input.frameOffsets[0] !== 0)
    throw new TypeError('person pose evidence frame_offsets must cover every frame')
  for (let index = 1; index < input.frameOffsets.length; index += 1)
    if (input.frameOffsets[index]! < input.frameOffsets[index - 1]!)
      throw new TypeError('person pose evidence frame_offsets must be monotonic')
  const observations = input.frameOffsets.at(-1) ?? 0
  for (const [name, column] of Object.entries({
    trackIds: input.trackIds,
    bboxSources: input.bboxSources,
    bboxX1: input.bboxX1,
    bboxY1: input.bboxY1,
    bboxX2: input.bboxX2,
    bboxY2: input.bboxY2,
    cropScaleX: input.cropScaleX,
    cropScaleY: input.cropScaleY,
    cropOffsetX: input.cropOffsetX,
    cropOffsetY: input.cropOffsetY,
    statuses: input.statuses,
  }))
    if (column.length !== observations)
      throw new TypeError(`person pose evidence ${name} length does not match observations`)
  if (input.observationSha256.length !== observations * PERSON_POSE_OBSERVATION_HASH_BYTES)
    throw new TypeError('person pose evidence observation hashes have an invalid length')
  for (const [name, column] of Object.entries({
    keypointX: input.keypointX,
    keypointY: input.keypointY,
    keypointConfidence: input.keypointConfidence,
  }))
    if (column.length !== observations * PERSON_POSE_KEYPOINT_COUNT)
      throw new TypeError(`person pose evidence ${name} length does not match COCO-17 observations`)
  if (input.bboxSources.some(value => value !== 0 && value !== 1))
    throw new TypeError('person pose evidence bbox source is invalid')
  if (input.statuses.some(value => !Number.isInteger(value) || value < 0 || value > 3))
    throw new TypeError('person pose evidence status is invalid')
  for (const column of [
    input.bboxX1,
    input.bboxY1,
    input.bboxX2,
    input.bboxY2,
    input.cropScaleX,
    input.cropScaleY,
    input.cropOffsetX,
    input.cropOffsetY,
    input.keypointX,
    input.keypointY,
    input.keypointConfidence,
  ])
    if (column.some(value => !Number.isFinite(value)))
      throw new TypeError('person pose evidence contains a non-finite number')
}

export function parsePersonPoseEvidenceChunk(bytes: Uint8Array): PersonPoseEvidenceChunk {
  const { bb, table } = root(bytes)
  const result: PersonPoseEvidenceChunk = {
    schemaVersion: stringField(bb, table, 0),
    analysisRunId: stringField(bb, table, 1),
    poseRecipeNamespace: stringField(bb, table, 2),
    startFrameIndex: u64(bb, table, 3),
    frameCount: u32(bb, table, 4),
    frameOffsets: u32Vector(bb, table, 5),
    trackIds: i32Vector(bb, table, 6),
    bboxSources: u8Vector(bb, table, 7) as PersonPoseBboxSource[],
    bboxX1: f32Vector(bb, table, 8),
    bboxY1: f32Vector(bb, table, 9),
    bboxX2: f32Vector(bb, table, 10),
    bboxY2: f32Vector(bb, table, 11),
    cropScaleX: f32Vector(bb, table, 12),
    cropScaleY: f32Vector(bb, table, 13),
    cropOffsetX: f32Vector(bb, table, 14),
    cropOffsetY: f32Vector(bb, table, 15),
    statuses: u8Vector(bb, table, 16) as PersonPoseObservationStatus[],
    observationSha256: u8Vector(bb, table, 17),
    keypointX: f32Vector(bb, table, 18),
    keypointY: f32Vector(bb, table, 19),
    keypointConfidence: f32Vector(bb, table, 20),
  }
  validate(result)
  return result
}

function u8Offset(builder: Builder, values: readonly number[]): Offset {
  builder.startVector(1, values.length, 1)
  for (let index = values.length - 1; index >= 0; index -= 1) builder.addInt8(values[index]!)
  return builder.endVector()
}

function i32Offset(builder: Builder, values: readonly number[]): Offset {
  builder.startVector(4, values.length, 4)
  for (let index = values.length - 1; index >= 0; index -= 1) builder.addInt32(values[index]!)
  return builder.endVector()
}

function f32Offset(builder: Builder, values: readonly number[]): Offset {
  builder.startVector(4, values.length, 4)
  for (let index = values.length - 1; index >= 0; index -= 1) builder.addFloat32(values[index]!)
  return builder.endVector()
}

export function encodePersonPoseEvidenceChunk(input: PersonPoseEvidenceChunk): Uint8Array {
  validate(input)
  const builder = new Builder(Math.max(1024, input.trackIds.length * 320))
  const schemaVersion = builder.createString(input.schemaVersion)
  const analysisRunId = builder.createString(input.analysisRunId)
  const poseRecipeNamespace = builder.createString(input.poseRecipeNamespace)
  const frameOffsets = i32Offset(builder, input.frameOffsets)
  const trackIds = i32Offset(builder, input.trackIds)
  const bboxSources = u8Offset(builder, input.bboxSources)
  const bboxX1 = f32Offset(builder, input.bboxX1)
  const bboxY1 = f32Offset(builder, input.bboxY1)
  const bboxX2 = f32Offset(builder, input.bboxX2)
  const bboxY2 = f32Offset(builder, input.bboxY2)
  const cropScaleX = f32Offset(builder, input.cropScaleX)
  const cropScaleY = f32Offset(builder, input.cropScaleY)
  const cropOffsetX = f32Offset(builder, input.cropOffsetX)
  const cropOffsetY = f32Offset(builder, input.cropOffsetY)
  const statuses = u8Offset(builder, input.statuses)
  const observationSha256 = u8Offset(builder, input.observationSha256)
  const keypointX = f32Offset(builder, input.keypointX)
  const keypointY = f32Offset(builder, input.keypointY)
  const keypointConfidence = f32Offset(builder, input.keypointConfidence)
  builder.startObject(21)
  builder.addFieldOffset(0, schemaVersion, 0)
  builder.addFieldOffset(1, analysisRunId, 0)
  builder.addFieldOffset(2, poseRecipeNamespace, 0)
  builder.addFieldInt64(3, input.startFrameIndex, 0n)
  builder.addFieldInt32(4, input.frameCount, 0)
  builder.addFieldOffset(5, frameOffsets, 0)
  builder.addFieldOffset(6, trackIds, 0)
  builder.addFieldOffset(7, bboxSources, 0)
  builder.addFieldOffset(8, bboxX1, 0)
  builder.addFieldOffset(9, bboxY1, 0)
  builder.addFieldOffset(10, bboxX2, 0)
  builder.addFieldOffset(11, bboxY2, 0)
  builder.addFieldOffset(12, cropScaleX, 0)
  builder.addFieldOffset(13, cropScaleY, 0)
  builder.addFieldOffset(14, cropOffsetX, 0)
  builder.addFieldOffset(15, cropOffsetY, 0)
  builder.addFieldOffset(16, statuses, 0)
  builder.addFieldOffset(17, observationSha256, 0)
  builder.addFieldOffset(18, keypointX, 0)
  builder.addFieldOffset(19, keypointY, 0)
  builder.addFieldOffset(20, keypointConfidence, 0)
  const result = builder.endObject()
  builder.finish(result, PERSON_POSE_EVIDENCE_IDENTIFIER)
  return builder.asUint8Array()
}
