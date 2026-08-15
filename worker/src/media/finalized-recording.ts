import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

export type FinalizedRecording = {
  captureSessionId: string
  trustedPath: string
  sourceIdentity: string
  byteLength: bigint
  mtimeNs: bigint
  finalized: boolean
}

export type FinalizedRecordingInput = {
  spoolRoot: string
  candidate: string
  captureSessionId: string
  finalized: boolean
}

const RECORDING_EXTENSIONS = new Set(['.mp4', '.m4s', '.fmp4'])

export function validateCaptureSessionId(captureSessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(captureSessionId)) {
    throw new Error('invalid capture session id')
  }
  return captureSessionId
}

export function normalizeSourceIdentity(sourceIdentity: string): string {
  if (
    !sourceIdentity ||
    sourceIdentity.includes('\0') ||
    isAbsolute(sourceIdentity) ||
    win32.isAbsolute(sourceIdentity)
  ) {
    throw new Error('invalid source identity')
  }

  const normalized = sourceIdentity.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('invalid source identity')
  }
  return segments.join('/')
}

export function assertFinalizedRecording(recording: FinalizedRecording): void {
  validateCaptureSessionId(recording.captureSessionId)
  normalizeSourceIdentity(recording.sourceIdentity)
  if (!isAbsolute(recording.trustedPath) && !win32.isAbsolute(recording.trustedPath)) {
    throw new Error('recording path must be absolute')
  }
  if (!recording.finalized) throw new Error('recording is not finalized')
  if (recording.byteLength <= 0n) throw new Error('recording is empty')
  if (recording.mtimeNs < 0n) throw new Error('recording mtime is invalid')
}

export async function parseFinalizedRecording(
  input: FinalizedRecordingInput,
): Promise<FinalizedRecording> {
  validateCaptureSessionId(input.captureSessionId)
  if (!input.candidate || isAbsolute(input.candidate) || win32.isAbsolute(input.candidate)) {
    throw new Error('recording candidate must be relative')
  }

  const trustedRoot = await realpath(input.spoolRoot)
  const trustedPath = await realpath(resolve(trustedRoot, input.candidate))
  const relativePath = relative(trustedRoot, trustedPath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath)
  ) {
    throw new Error('recording path escapes spool root')
  }
  if (!RECORDING_EXTENSIONS.has(extname(trustedPath).toLowerCase())) {
    throw new Error('unknown recording extension')
  }

  const metadata = await stat(trustedPath, { bigint: true })
  if (!metadata.isFile()) throw new Error('recording is not a file')
  if (metadata.size <= 0n) throw new Error('recording is empty')

  return {
    captureSessionId: input.captureSessionId,
    trustedPath,
    sourceIdentity: normalizeSourceIdentity(relativePath),
    byteLength: metadata.size,
    mtimeNs: metadata.mtimeNs,
    finalized: input.finalized,
  }
}
