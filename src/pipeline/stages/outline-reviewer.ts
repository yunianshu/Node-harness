import { Stage, StageContext, invokeRetryOnTruncation } from './stage.js'
import { ReviewReport, ReviewReportSchema } from '../schemas.js'
import { extractJsonLoose } from './json-utils.js'
import { PromptBuilder } from '../prompt-builder.js'
import { compressReviewFeedback } from '../feedback-compressor.js'
import type { SpacetimeEntry } from '../../memory/matrix-store.js'

export interface OutlineReviewInput {
  outlineJson: string
  chapter: number
  stylePack: import('../../quality/style-pack-loader.js').StylePack
  gate: number
  previousSpacetime: SpacetimeEntry | null
  stalledMysteryAlert: boolean
  historyReports: ReviewReport[]
}

export interface OutlineReviewOutput {
  report: ReviewReport
  passed: boolean
  sceneContinuityBroken: boolean
}

export class OutlineReviewerStage extends Stage<OutlineReviewInput, OutlineReviewOutput> {
  private readonly builder = new PromptBuilder()

  constructor() {
    super('outline-reviewer')
  }

  protected async run(input: OutlineReviewInput, ctx: StageContext): Promise<OutlineReviewOutput> {
    const signals: string[] = []
    if (input.stalledMysteryAlert) signals.push('- 悬念长期停滞：本章必须推进至少一个待解悬念')
    if (input.previousSpacetime) {
      signals.push(
        `- 上一章末时空状态：地点「${input.previousSpacetime.endScene.location}」，时间 ${input.previousSpacetime.timeline}。本章首场景必须与之衔接，否则标记严重问题「场景衔接断裂」`,
      )
    }
    const prompt = this.builder.buildReviewPrompt({
      kind: 'outline',
      chapter: input.chapter,
      content: input.outlineJson,
      stylePack: input.stylePack,
      gate: input.gate,
      consistencySignalsDigest: signals.length > 0 ? signals.join('\n') : null,
      previousSpacetimeDigest: null,
    })
    const response = await invokeRetryOnTruncation(() =>
      ctx.gateway.invoke('outline-reviewer', prompt, {
        projectId: ctx.projectId,
        chapter: input.chapter,
      }),
    )
    this.lastReasoning = response.reasoning ?? null
    const parsed = extractJsonLoose(response.content) as Record<string, unknown>
    const report = ReviewReportSchema.parse({
      ...parsed,
      target: { kind: 'outline', chapter: input.chapter, version: 1 },
      reviewerModelMasked: 'outline-reviewer',
    })

    const sceneContinuityBroken = report.issues.some(
      (i) => i.severity === 'severe' && i.description.includes('场景衔接断裂'),
    )
    const passed =
      report.score >= input.gate &&
      report.styleDeviation !== 'severe' &&
      !report.issues.some((i) => i.severity === 'severe') &&
      !sceneContinuityBroken

    return { report, passed, sceneContinuityBroken }
  }
}

export function compressedOutlineFeedback(reports: ReviewReport[]): string | null {
  return compressReviewFeedback(reports)?.formatted ?? null
}