import type { Context } from 'cordis'
import { FakeHost, DshHostAdapter, DshHostRuntime } from './host/dsh-adapter.js'
import type { HostProvider } from './host/types.js'

export const name = 'novel-harness'

export interface PluginConfig {
  host?: HostProvider
  dshRuntime?: DshHostRuntime
  dataRoot?: string
}

export const inject: string[] = []

declare module 'cordis' {
  interface Context {
    novelHost: HostProvider
  }
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const host = config.host ?? (config.dshRuntime ? new DshHostAdapter(config.dshRuntime) : new FakeHost(config.dataRoot))
  ctx.novelHost = host

  ctx.on('dispose', () => {
    if (ctx.novelHost === host) {
      ;(ctx as { novelHost?: HostProvider }).novelHost = undefined
    }
  })
}

export { FakeHost, DshHostAdapter }
export type { HostProvider, DshHostRuntime }