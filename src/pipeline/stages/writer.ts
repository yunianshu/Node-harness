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
    // 正文流式（Task #8）：首轮经 invokeStream 逐字回调 onDelta（会话消息流呈现）；
    // length 截断重试走非流式聚合（静默重试），避免 UI 收到两段正文，最终以聚合结果落盘。
    const stream = () =>
      ctx.gateway.invokeStream(
        'writer',
        prompt,
        {
          projectId: ctx.projectId,
          chapter: input.chapter,
        },
        (delta) => ctx.onDelta?.(input.chapter, delta),
      )
    let response = await stream()
    // 推理模型（glm-5.3 等）思考段与正文共享 maxOutputTokens 预算：思考过深会把正文
    // 挤到 finish_reason=length 截断（实测 reasoning 6311/8192，正文在句中断开）。
    // 重试一次期望本轮思考收敛、正文收尾；重试后仍截断则判失败（走章级重写/隔离），
    // 不让半截正文静默流入终稿。
    if (response.finishReason === 'length') {
      response = await ctx.gateway.invoke('writer', prompt, {
        projectId: ctx.projectId,
        chapter: input.chapter,
      })
    }
    if (response.finishReason === 'length') {
      throw new Error('写作者输出被 token 预算截断（finish_reason=length），重试后仍不完整——建议上调 writer 角色 maxOutputTokens')
    }
    const text = response.content.trim()
    if (text.length === 0) throw new Error('写作者返回空正文')
    return text
  }
}