import { describe, expect, it } from 'vitest'
import { createSampleSnapResolver } from '../src/media/sample-snap-resolver.js'
describe('sample snap resolver', () => {
 it('preserves ordered IDs and bigint player time', async () => {
  const ids:string[]=[]; const resolver=createSampleSnapResolver(async requested=>{ids.push(...requested); return [{segmentId:'a',discontinuity:0,index:{epochId:'e',timeBase:{num:1n,den:1n},samples:[{sourcePts:0n,durationPts:10n,captureTimeUs:9007199254740993n,captureFrameIndex:0n,keyframe:true}],availableStartUs:9007199254740993n,availableEndUs:9007199254741003n}},{segmentId:'b',discontinuity:0,index:{epochId:'e',timeBase:{num:1n,den:1n},samples:[{sourcePts:10n,durationPts:10n,captureTimeUs:9007199254741003n,captureFrameIndex:1n,keyframe:false}],availableStartUs:9007199254741003n,availableEndUs:9007199254741013n}}]})
  await expect(resolver({targetUs:9007199254740993n,segments:[{id:'a',captureStartUs:9007199254740993n,captureEndUs:9007199254741003n},{id:'b',captureStartUs:9007199254741003n,captureEndUs:9007199254741013n}]})).resolves.toEqual({captureUs:9007199254740993n,playerUs:0n}); expect(ids).toEqual(['a','b'])
 })
 it('fails closed on empty or loader failure', async()=>{ await expect(createSampleSnapResolver(async()=>{throw Error('corrupt')})({targetUs:1n,segments:[]})).rejects.toThrow(); await expect(createSampleSnapResolver(async()=>{throw Error('corrupt')})({targetUs:1n,segments:[{id:'a',captureStartUs:0n,captureEndUs:2n}]})).rejects.toThrow('corrupt') })
})
