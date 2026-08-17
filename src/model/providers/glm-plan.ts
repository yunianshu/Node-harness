import { PlanLimitError } from '../errors.js'

export const PLAN_LIMIT_PROBE_INTERVAL_MS = 60_000

export interface PlanLimitProbeResult {
  recovered: boolean
  probedAt: string
}

export function isPlanLimitError(err: unknown): err is PlanLimitError {
  return err instanceof PlanLimitError
}

export function planLimitWaitMessage(providerId: string): string {
  return `GLM Coding Plan 限额触发，通道 ${providerId} 进入限额等待`
}

export async function probeChannel(
  probeCall: () => Promise<unknown>,
  attempts = 1,
): Promise<PlanLimitProbeResult> {
  for (let i = 0; i < attempts; i++) {
    try {
      await probeCall()
      return { recovered: true, probedAt: new Date().toISOString() }
    } catch (err) {
      if (isPlanLimitError(err)) continue
      throw err
    }
  }
  return { recovered: false, probedAt: new Date().toISOString() }
}