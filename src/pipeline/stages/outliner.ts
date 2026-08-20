import { Stage } from './stage.js'
import { ChapterOutline, ChapterOutlineSchema, validateOutlineStructure } from '../schemas.js'
import { extractJsonLoose } from './json-utils.js'
import { PromptBuilder, OutlinePromptInput } from '../prompt-builder.js'

export class OutlineIncompleteError extends Error {
  readonly code = 'OUTLINE_INCOMPLETE'
  constructor(readonly problems: string[]) {
    super(`章纲结构问题：${problems.join('；')}`)
    this.name = 'OutlineIncompleteError'
  }
}

export class OutlinerStage extends Stage<OutlinePromptInput, ChapterOutline> {
  private readonly builder = new PromptBuilder()

  constructor() {
    super('outliner')
  }

  protected async run(input: OutlinePromptInput, ctx: import('./stage.js').StageContext): Promise<ChapterOutline> {
    const prompt = this.builder.buildOutlinePrompt(input)
    const response = await ctx.gateway.invoke('outliner', prompt, {
      projectId: ctx.projectId,
      chapter: input.chapter,
    })
    this.lastReasoning = response.reasoning ?? null
    const parsed = extractJsonLoose(response.content) as Record<string, unknown>
    const schemaCheck = ChapterOutlineSchema.safeParse({ ...parsed, chapter: (parsed as { chapter?: number })?.chapter ?? input.chapter })
    if (!schemaCheck.success) {
      throw new OutlineIncompleteError([`${schemaCheck.error.issues[0].path.join('.')}: ${schemaCheck.error.issues[0].message}`])
    }
    const structure = validateOutlineStructure(schemaCheck.data, input.locationNames, [])
    if (!structure.ok || structure.value === null) throw new OutlineIncompleteError(structure.problems)

    // 使用地点引用归一后的章纲（「旧宅废墟」→「旧宅废墟（沈家老宅）」等）
    const outline = structure.value
    const mode: 'first' | 'directed' | 'full-regen' = input.mode
    outline.rewriteTrace = [
      ...((input.previousOutline?.rewriteTrace ?? []).filter(() => mode === 'directed')),
      { mode, round: (input.previousOutline?.rewriteTrace.length ?? 0) + 1, at: new Date().toISOString() },
    ]
    return outline
  }
}