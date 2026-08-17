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
    const parsed = extractJsonLoose(response.content) as Record<string, unknown>
    const schemaCheck = ChapterOutlineSchema.safeParse({ ...parsed, chapter: (parsed as { chapter?: number })?.chapter ?? input.chapter })
    if (!schemaCheck.success) {
      throw new OutlineIncompleteError([`${schemaCheck.error.issues[0].path.join('.')}: ${schemaCheck.error.issues[0].message}`])
    }
    const structure = validateOutlineStructure(schemaCheck.data, input.locationNames, [])
    if (!structure.ok) throw new OutlineIncompleteError(structure.problems)

    const outline = schemaCheck.data
    const mode: 'first' | 'directed' | 'full-regen' = input.mode
    outline.rewriteTrace = [
      ...((input.previousOutline?.rewriteTrace ?? []).filter((t) => mode === 'directed')),
      { mode, round: (input.previousOutline?.rewriteTrace.length ?? 0) + 1, at: new Date().toISOString() },
    ]
    return outline
  }
}