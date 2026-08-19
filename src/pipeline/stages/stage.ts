import type { ModelGateway } from '../../model/gateway.js'
import type { ChatResponse } from '../../model/providers/openai-compat.js'

/**
 * 推理模型（如 MiniMax-M3）思考段可能挤占输出预算，导致 finish_reason=length
 * 截断、JSON 未闭合无法解析。对截断结果重试一次（同 prompt 二次生成），期望本轮完整收尾。
 */
export async function invokeRetryOnTruncation(invoke: () => Promise<ChatResponse>): Promise<ChatResponse> {
  const first = await invoke()
  if (first.finishReason !== 'length') return first
  return invoke()
}

export interface StageLogEntry {
  ts: string
  stage: string
  chapter?: number
  model?: string
  durationMs: number
  result: 'ok' | 'failed'
  errorClass?: string
}

export interface StageContext {
  projectId: string
  gateway: ModelGateway
  log: (entry: StageLogEntry) => void
  signal?: AbortSignal
  /** 正文流式回调：writer 等阶段把逐字增量透传给上层（Task #8）。 */
  onDelta?: (chapter: number, text: string) => void
}

export abstract class Stage<TInput, TOutput> {
  constructor(readonly stageName: string) {}

  async execute(input: TInput, ctx: StageContext): Promise<TOutput> {
    const started = Date.now()
    try {
      const output = await this.run(input, ctx)
      ctx.log({
        ts: new Date().toISOString(),
        stage: this.stageName,
        durationMs: Date.now() - started,
        result: 'ok',
      })
      return output
    } catch (err) {
      ctx.log({
        ts: new Date().toISOString(),
        stage: this.stageName,
        durationMs: Date.now() - started,
        result: 'failed',
        errorClass: err instanceof Error ? err.constructor.name : String(err),
      })
      throw err
    }
  }

  protected abstract run(input: TInput, ctx: StageContext): Promise<TOutput>
}