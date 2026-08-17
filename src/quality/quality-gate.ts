import type { QualityGates, StructuredQuality, AiFlavorConfig } from '../project/schema.js'
import { checkStructured, StructuredCheckResult } from './structured-checker.js'
import { runDeAiChecks, DeAiCheckResult } from './de-ai/checker.js'

export interface QualityGateConfig {
  structured: StructuredQuality
  aiFlavor: AiFlavorConfig
}

export interface DraftCheckOutcome {
  structured: StructuredCheckResult
  deAi: DeAiCheckResult
  passed: boolean
  directRewrite: boolean
  rewriteReasons: string[]
}

export function checkDraft(text: string, config: QualityGateConfig): DraftCheckOutcome {
  const structured = checkStructured(text, config.structured)
  const deAi = runDeAiChecks(text, config.aiFlavor)
  const severeHit = deAi.hasSevere
  const passed = structured.passed && deAi.passed
  const rewriteReasons: string[] = []
  if (!structured.passed) rewriteReasons.push(...structured.failures.map((f) => f.message))
  if (!deAi.passed) {
    for (const hit of deAi.hits) {
      rewriteReasons.push(`[AI味/${hit.severity}] ${hit.type}: ${hit.excerpt}`)
    }
  }
  return {
    structured,
    deAi,
    passed,
    directRewrite: severeHit || !structured.passed,
    rewriteReasons,
  }
}

export interface ModelReviewLike {
  score: number
  styleDeviation: 'none' | 'minor' | 'severe'
}

export interface ChapterVerdict {
  accepted: boolean
  reasons: string[]
  score: number
  hardCheckPassed: boolean
}

export function verdict(
  modelReview: ModelReviewLike,
  draftCheck: DraftCheckOutcome,
  gates: QualityGates,
): ChapterVerdict {
  const reasons: string[] = []
  const hardCheckPassed = draftCheck.structured.passed && !draftCheck.deAi.hasSevere

  if (modelReview.score < gates.draftGate) {
    reasons.push(`模型评分 ${modelReview.score} 低于门槛 ${gates.draftGate}`)
  }
  if (modelReview.styleDeviation === 'severe') {
    reasons.push('严重风格偏离（风格锚点）')
  }
  if (!draftCheck.structured.passed) {
    reasons.push(...draftCheck.structured.failures.map((f) => `结构化检查未过：${f.message}`))
  }
  if (draftCheck.deAi.hasSevere) {
    reasons.push(
      ...draftCheck.deAi.hits
        .filter((h) => h.severity === 'severe')
        .map((h) => `AI 味严重命中：${h.type} ${h.excerpt}`),
    )
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    score: modelReview.score,
    hardCheckPassed,
  }
}