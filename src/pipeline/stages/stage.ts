import type { ModelGateway } from '../../model/gateway.js'

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