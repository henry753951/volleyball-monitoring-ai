import {
  ReidCorrectionDisplayScope,
  ReidFutureEvidenceAction,
} from '@volleyball-monitoring/db/client'
import { describe, expect, it } from 'vitest'
import {
  correctionPolicyForIdentityMode,
  positionInCorrectionScope,
} from '../src/services/reid-identity-ledger.js'

describe('versioned ReID correction policy', () => {
  it('defaults the user-facing correction to from-here without rewriting earlier clips', () => {
    expect(correctionPolicyForIdentityMode('from_here')).toEqual({
      displayScope: ReidCorrectionDisplayScope.FROM_HERE,
      futureEvidenceAction: ReidFutureEvidenceAction.REJECT_SOURCE_AND_CONFIRM_TARGET,
    })
    const anchor = { setNumber: 2, rallyOrdinal: 5 }
    expect(
      positionInCorrectionScope(
        { setNumber: 2, rallyOrdinal: 4 },
        anchor,
        ReidCorrectionDisplayScope.FROM_HERE,
      ),
    ).toBe(false)
    expect(
      positionInCorrectionScope(
        { setNumber: 2, rallyOrdinal: 5 },
        anchor,
        ReidCorrectionDisplayScope.FROM_HERE,
      ),
    ).toBe(true)
    expect(
      positionInCorrectionScope(
        { setNumber: 3, rallyOrdinal: 1 },
        anchor,
        ReidCorrectionDisplayScope.FROM_HERE,
      ),
    ).toBe(true)
  })

  it('keeps clip-only display changes out of the future feature bank', () => {
    expect(correctionPolicyForIdentityMode('clip_only')).toEqual({
      displayScope: ReidCorrectionDisplayScope.CURRENT_CLIP,
      futureEvidenceAction: ReidFutureEvidenceAction.NONE,
    })
  })
})
