import { Stage, StageContext } from './stage.js'
import { invokeRetryOnTruncation } from './stage.js'
import { ReviewReport, ReviewReportSchema } from '../schemas.js'
import { extractJsonLoose } from './json-utils.js'
import { PromptBuilder } from '../prompt-builder.js'
import type { ConsistencySignals } from '../../memory/rules.js'
import type { SpacetimeEntry } from '../../memory/matrix-store.js'
import type { StylePack } from '../../quality/style-pack-loader.js'

export interface ReviewerInput {
  chapter: number
  draftText: string
  /** 被审查草稿的版本号（初稿 1，重写递增）；此前硬编码 1 导致所有审查 target 版本都标错。 */
  version: number
  outlineSummary: string
  stylePack: StylePack
  gate: number
  signals: ConsistencySignals | null
  previousSpacetime: SpacetimeEntry | null
  locationDigest: string
}

export interface ReviewerOutput {
  report: ReviewReport
  passed: boolean
}

export class ReviewerStage extends Stage<ReviewerInput, ReviewerOutput> {
  private readonly builder = new PromptBuilder()

  constructor() {
    super('reviewer')
  }

  protected async run(input: ReviewerInput, ctx: StageContext): Promise<ReviewerOutput> {
    const signalsDigest = this.signalsDigest(input)
    const prompt = this.builder.buildReviewPrompt({
      kind: 'draft',
      chapter: input.chapter,
      content: input.draftText,
      stylePack: input.stylePack,
      gate: input.gate,
      consistencySignalsDigest: signalsDigest,
      previousSpacetimeDigest: input.previousSpacetime
        ? `地点「${input.previousSpacetime.endScene.location}」，时间 ${input.previousSpacetime.timeline}`
        : null,
    })
    const response = await invokeRetryOnTruncation(() =>
      ctx.gateway.invoke('reviewer', prompt, {
        projectId: ctx.projectId,
        chapter: input.chapter,
      }),
    )
    this.lastReasoning = response.reasoning ?? null
    const parsed = extractJsonLoose(response.content) as Record<string, unknown>
    const report = ReviewReportSchema.parse({
      ...parsed,
      target: { kind: 'draft', chapter: input.chapter, version: input.version },
      reviewerModelMasked: 'reviewer',
    })

    const passed =
      report.score >= input.gate && report.styleDeviation !== 'severe' && !report.issues.some((i) => i.severity === 'severe')

    return { report, passed }
  }

  signalsDigest(input: ReviewerInput): string | null {
    const lines: string[] = []
    const s = input.signals
    if (s) {
      if (s.protagonistAbsentStreak >= 2) {
        lines.push(`- 主角已连续 ${s.protagonistAbsentStreak} 章未出场（若无章纲标注的剧情性缺席，达到 3 章应判不通过）`)
      }
      if (s.passerbyDrift.length > 0) {
        lines.push(`- 路人漂移：${s.passerbyDrift.map((d) => `${d.name}（${d.chapters.join(',')}章登场）`).join('；')}，应升级配角或削减戏份`)
      }
      if (s.supportingOverdue.length > 0) {
        lines.push(`- 重要配角久未出场且伏笔未闭环：${s.supportingOverdue.map((d) => d.name).join('、')}`)
      }
      if (s.overdueForeshadows.length > 0) {
        lines.push(`- 超期未揭示伏笔：${s.overdueForeshadows.map((f) => `${f.id}「${f.title}」`).join('；')}`)
      }
    }
    if (input.previousSpacetime) {
      lines.push(
        `- 环境连续性：上一章末在「${input.previousSpacetime.endScene.location}」（${input.previousSpacetime.timeline}）。本章开头若无故换场景，标记严重问题「环境断裂」`,
      )
    }
    return lines.length > 0 ? lines.join('\n') : null
  }
}