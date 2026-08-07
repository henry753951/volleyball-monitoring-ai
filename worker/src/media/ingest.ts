import { createHash } from 'node:crypto';
import type { SampleIndex } from './sample-index';

export type FinalizedRecording = { captureSessionId: string; path: string; size: bigint; contentType: string; finalized: boolean; sha256: string };
export type MediaObject = { key: string; bytes: Uint8Array; contentType: string; sha256: string; byteLength: bigint; schemaVersion?: string };
export interface MediaObjectStore { putUploading(object: MediaObject): Promise<void>; verifyReady(key: string, metadata: { sha256: string; byteLength: bigint; contentType: string; schemaVersion: string }): Promise<void>; }
export interface MediaIngestRepository { claim(idempotencyKey: string): Promise<'CLAIMED' | 'ALREADY_READY' | 'RETRY'>; publishReady(input: { idempotencyKey: string; objectKeys: string[]; sampleIndex: SampleIndex }): Promise<void>; }
export type IngestPorts = { store: MediaObjectStore; repository: MediaIngestRepository; buildObjects(recording: FinalizedRecording): Promise<MediaObject[]> };
export function idempotencyKey(r: FinalizedRecording): string { return `${r.captureSessionId}:${r.path}:${r.size.toString()}:${r.sha256}`; }
export function planObjectKey(bucket: string, sessionId: string, identity: string, kind: 'init'|'media'|'index'): string { if (!bucket || bucket.includes('/')) throw new Error('invalid bucket'); return `${bucket}/dvr/${sessionId}/${identity}/${kind}`; }
export async function ingestFinalizedSegment(recording: FinalizedRecording, ports: IngestPorts, sampleIndex: SampleIndex): Promise<'published'|'already_ready'|'retry'> {
  if (!recording.finalized || recording.size <= 0n) throw new Error('recording is not finalized');
  const claim = await ports.repository.claim(idempotencyKey(recording)); if (claim === 'ALREADY_READY') return 'already_ready'; if (claim !== 'CLAIMED') return 'retry';
  try { const objects = await ports.buildObjects(recording); for (const object of objects) await ports.store.putUploading(object); for (const object of objects) await ports.store.verifyReady(object.key, { sha256: object.sha256, byteLength: object.byteLength, contentType: object.contentType, schemaVersion: '1.0.0' }); await ports.repository.publishReady({ idempotencyKey: idempotencyKey(recording), objectKeys: objects.map(o => o.key), sampleIndex }); return 'published'; } catch { return 'retry'; }
}
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
