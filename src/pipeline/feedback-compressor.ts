import type { ReviewReport } from './schemas.js'

export interface CompressedFeedback {
  bestScore: number | null
  latestVerdict: string
  topReasons: string[]
  formatted: string
}

export function compressReviewFeedback(reports: ReviewReport[], maxReasons = 6): CompressedFeedback | null {
  if (reports.length === 0) return null
  const best = reports.reduce((a, b) => (b.score > a.score ? b : a))
  const latest = reports[reports.length - 1]

  const allIssues = reports.flatMap((r) => r.issues.map((i) => `[${i.severity}] ${i.description}`))
  const seen = new Set<string>()
  const uniqueReasons: string[] = []
  for (const issue of allIssues) {
    if (seen.has(issue)) continue
    seen.add(issue)
    uniqueReasons.push(issue)
  }
  uniqueReasons.sort((a, b) => rank(b) - rank(a))
  const topReasons = uniqueReasons.slice(0, maxReasons)

  const softFindings = latest.aiFlavorVerdict.softFindings.slice(0, 3)
  const parts: string[] = []
  parts.push(`历次最高分：${best.score}（本轮要求通过门槛）`)
  parts.push(`最近结论：${latest.rewriteFeedback ?? (latest.issues.map((i) => i.description).join('；') || '待改进')}`)
  parts.push(`主要问题（前 ${topReasons.length} 条）：\n${topReasons.map((r) => `- ${r}`).join('\n')}`)
  if (softFindings.length > 0) parts.push(`AI味软检查：${softFindings.join('；')}`)

  return {
    bestScore: best.score,
    latestVerdict: latest.rewriteFeedback ?? '',
    topReasons,
    formatted: parts.join('\n'),
  }
}

function rank(issue: string): number {
  if (issue.startsWith('[severe]')) return 3
  if (issue.startsWith('[general]')) return 2
  return 1
}