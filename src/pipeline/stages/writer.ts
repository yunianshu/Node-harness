import { Stage, StageContext } from './stage.js'
import { ChapterOutline } from '../schemas.js'
import { PromptBuilder } from '../prompt-builder.js'

export interface WriterInput {
  chapter: number
  outline: ChapterOutline
  world: { worldview: string }
  charactersDigest: string
  injection: import('../../memory/injection-builder.js').MatrixInjection | null
  previousChapterEnding: string | null
  mode: 'first' | 'directed'
  reviewFeedback: string | null
  aiFlavorHits: string[]
  guidanceNote: string | null
  stylePack: import('../../quality/style-pack-loader.js').StylePack
  wordRange: { min: number; max: number }
}

export class WriterStage extends Stage<WriterInput, string> {
  private readonly builder = new PromptBuilder()

  constructor() {
    super('writer')
  }

  protected async run(input: WriterInput, ctx: StageContext): Promise<string> {
    const prompt = this.builder.buildWriterPrompt({
      chapter: input.chapter,
      outline: input.outline,
      world: input.world,
      charactersDigest: input.charactersDigest,
      injection: input.injection,
      previousChapterEnding: input.previousChapterEnding,
      mode: input.mode,
      reviewFeedback: input.reviewFeedback,
      aiFlavorHits: input.aiFlavorHits,
      guidanceNote: input.guidanceNote,
      stylePack: input.stylePack,
      wordRange: input.wordRange,
    })
    const response = await ctx.gateway.invoke('writer', prompt, {
      projectId: ctx.projectId,
      chapter: input.chapter,
    })
    const text = response.content.trim()
    if (text.length === 0) throw new Error('写作者返回空正文')
    return text
  }
}