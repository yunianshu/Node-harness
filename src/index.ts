import type { Context } from 'cordis'
import { NovelHarnessApp } from './app.js'
import { FakeHost, DshHostAdapter, DshHostRuntime } from './host/dsh-adapter.js'
import type { HostProvider } from './host/types.js'

export const name = 'novel-harness'

export interface PluginConfig {
  host?: HostProvider
  dshRuntime?: DshHostRuntime
  dataRoot?: string
  stylePackRoot?: string
}

export const inject: string[] = []

declare module 'cordis' {
  interface Context {
    novelApp: NovelHarnessApp
  }
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const app = new NovelHarnessApp({
    host: config.host ?? (config.dshRuntime ? new DshHostAdapter(config.dshRuntime) : new FakeHost(config.dataRoot)),
    dataRoot: config.dataRoot,
    stylePackRoot: config.stylePackRoot,
  })
  ctx.novelApp = app

  ctx.on('dispose', () => {
    if (ctx.novelApp === app) {
      ;(ctx as { novelApp?: NovelHarnessApp }).novelApp = undefined
    }
  })
}

export { NovelHarnessApp, FakeHost, DshHostAdapter }
export type { HostProvider, DshHostRuntime }
