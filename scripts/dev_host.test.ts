import { describe, expect, it } from 'bun:test'
import { createDevelopmentProcesses, createHostDevelopmentEnvironment } from './dev_host.js'

describe('host development environment', () => {
  it('uses the same safe RTMP host-port default as Compose', () => {
    const environment = createHostDevelopmentEnvironment({})

    expect(environment.MEDIA_INGEST_BASE_URL).toBe('rtmp://127.0.0.1:2035/app')
  })

  it('maps container DNS endpoints to loopback ports without changing browser API paths', () => {
    const environment = createHostDevelopmentEnvironment({
      POSTGRES_HOST_PORT: '15433',
      REDIS_HOST_PORT: '16380',
      MINIO_HOST_PORT: '19000',
      OME_API_HOST_PORT: '18081',
      OME_RTMP_HOST_PORT: '11935',
      DEV_DATA_ROOT: 'F:\\vollyai-dev-data',
      SERVER_DEV_PORT: '14000',
      WEB_DEV_PORT: '13100',
    })

    expect(environment.DATABASE_URL).toContain('@127.0.0.1:15433/')
    expect(environment.REDIS_URL).toBe('redis://127.0.0.1:16380/0')
    expect(environment.MINIO_ENDPOINT).toBe('http://127.0.0.1:19000')
    expect(environment.MEDIA_SPOOL_DIR).toBe('F:\\vollyai-dev-data\\media-spool')
    expect(environment.MEDIA_IMPORT_ROOT).toBe('F:\\vollyai-dev-data\\media-imports')
    expect(environment.OME_API_URL).toBe('http://127.0.0.1:18081')
    expect(environment.MEDIA_INGEST_BASE_URL).toBe('rtmp://127.0.0.1:11935/app')
    expect(environment.NUXT_DEV_BACKEND_ORIGIN).toBe('http://127.0.0.1:14000')
    expect(environment.NUXT_PORT).toBe('13100')
    const processes = createDevelopmentProcesses(environment, true)
    expect(processes.find(process => process.name === 'web')?.command).toContain('13100')
    expect(processes.find(process => process.name === 'web')?.environment).toEqual({ NUXT_IGNORE_LOCK: '1' })
    expect(processes.find(process => process.name === 'worker-media')?.environment).toEqual({ WORKER_HEALTH_PORT: '4101' })
  })
})
