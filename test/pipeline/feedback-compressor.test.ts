import { describe, expect, it } from 'vitest'
import { compressReviewFeedback } from '../../src/pipeline/feedback-compressor'
import { ReviewReport } from '../../src/pipeline/schemas'

function report(score: number, issues: Array<[string, string]> = [], feedback?: string): ReviewReport {
  return {
    target: { kind: 'draft', chapter: 1, version: 1 },
    score,
    issues: issues.map(([severity, description]) => ({ severity: severity as 'severe', description, location: '' })),
    styleDeviation: 'none',
    aiFlavorVerdict: { hardHits: [], softFindings: [] },
    rewriteFeedback: feedback,
    reviewerModelMasked: 'reviewer',
  }
}

describe('feedback compressor', () => {
  it('keeps best score, latest verdict and top reasons within 6', () => {
    const reports = [
      report(5.0, [['minor', '节奏偏慢'], ['general', '对话过长']]),
      report(6.2, [['severe', '主角缺席'], ['general', '节奏偏慢'], ['minor', '环境描写少'], ['minor', 'a'], ['minor', 'b'], ['minor', 'c'], ['minor', 'd']]),
      report(5.8, [], '重点压缩第二幕'),
    ]
    const compressed = compressReviewFeedback(reports)!
    expect(compressed.bestScore).toBe(6.2)
    expect(compressed.latestVerdict).toBe('重点压缩第二幕')
    expect(compressed.topReasons.length).toBeLessThanOrEqual(6)
    expect(compressed.topReasons[0]).toContain('主角缺席')
    expect(compressed.formatted).toContain('历次最高分：6.2')
  })

  it('returns null for empty history', () => {
    expect(compressReviewFeedback([])).toBeNull()
  })

  it('dedups repeated issues across rounds', () => {
    const reports = [report(5, [['general', '重复问题']]), report(6, [['general', '重复问题']])]
    const compressed = compressReviewFeedback(reports)!
    expect(compressed.topReasons.filter((r) => r.includes('重复问题'))).toHaveLength(1)
  })
})