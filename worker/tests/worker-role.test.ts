import { describe, expect, it } from 'vitest'
import { validateWorkerRole } from '../src/worker-role.js'

describe('validateWorkerRole', () => {
  it.each([
    'media',
    'workflow',
    'ai-dispatcher',
  ])('accepts %s', (role) => {
    expect(validateWorkerRole(role)).toBe(role)
  })

  it('rejects unsupported roles with the runtime error', () => {
    expect(() => validateWorkerRole('unsupported')).toThrow(
      'Unsupported WORKER_ROLE: unsupported',
    )
  })
})
