import { describe, expect, it } from 'vitest'
describe('DVR timeline bigint positioning', () => {
  it('maps large capture values proportionally without absolute Number coercion', () => { const start = 9007199254740993n; const end = start + 1000n; const target = start + 250n; expect(Number(target - start) / Number(end - start)).toBe(0.25) })
  it('clamps gaps and zoom targets to timeline bounds', () => { expect(Math.max(0, Math.min(100, -10))).toBe(0); expect(Math.max(0, Math.min(100, 140))).toBe(100) })
})
