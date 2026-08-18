export type OmePresentationObservation = {
  firstMediaSequence: bigint
  playlistUrl: string
  programDateTime: Date
  streamInstanceId: string
}

export function omeMasterPlaylistUrl(llhlsBaseUrl: string, ingestPath: string): string {
  const base = llhlsBaseUrl.replace(/\/+$/, '')
  const stream = ingestPath
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/')
  if (!base || !stream) throw new TypeError('OME LL-HLS source path is incomplete')
  return `${base}/app/${stream}/master.m3u8`
}

export function parseOmeVideoPlaylistUrl(master: string, masterUrl: string): string {
  const lines = master.split(/\r?\n/).map(line => line.trim())
  const streamInfo = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'))
  if (streamInfo < 0) throw new Error('OME_MASTER_VIDEO_RENDITION_MISSING')
  const uri = lines.slice(streamInfo + 1).find(line => line.length > 0 && !line.startsWith('#'))
  if (!uri) throw new Error('OME_MASTER_VIDEO_URI_MISSING')
  return new URL(uri, masterUrl).toString()
}

export function parseOmePresentationObservation(
  playlist: string,
  playlistUrl: string,
): OmePresentationObservation {
  const mediaSequenceMatch = playlist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m)
  const programDateTimeMatch = playlist.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+?)\s*$/m)
  const instanceMatch = new URL(playlistUrl).pathname.match(
    /\/chunklist_\d+_video_([A-Za-z0-9_-]+)_llhls\.m3u8$/,
  )
  if (!mediaSequenceMatch) throw new Error('OME_MEDIA_SEQUENCE_MISSING')
  if (!programDateTimeMatch) throw new Error('OME_PROGRAM_DATE_TIME_MISSING')
  if (!instanceMatch) throw new Error('OME_STREAM_INSTANCE_ID_MISSING')
  const programDateTime = new Date(programDateTimeMatch[1]!)
  if (Number.isNaN(programDateTime.getTime())) throw new Error('OME_PROGRAM_DATE_TIME_INVALID')
  return {
    firstMediaSequence: BigInt(mediaSequenceMatch[1]!),
    playlistUrl,
    programDateTime,
    streamInstanceId: instanceMatch[1]!,
  }
}
