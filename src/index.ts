import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { NovelHarnessApp, type CommandSpec } from './app.js'
import { DshHostAdapter, FakeHost } from './host/dsh-adapter.js'
import type { HostProvider } from './host/types.js'
import { coerceFlags, commandNameOf, parseFlags, usageOf } from './command-line.js'

export const name = 'novel-harness'

/** 依赖底座命令注册与凭据服务（dsh-base 默认装载）。 */
export const inject = ['commands', 'credentials']

export interface PluginConfig {
  /** 测试/离线开发时注入的宿主实现；缺省经 DshHostAdapter 对接真实底座。 */
  host?: HostProvider
  /** 覆盖默认数据根目录（$DSH_HOME/novels）。 */
  dataRoot?: string
  stylePackRoot?: string
}

/** 将 NovelHarnessApp 以命名服务挂到 ctx，随插件 fiber 自动注销。 */
class NovelAppService extends Service {
  constructor(ctx: Context, readonly app: NovelHarnessApp) {
    super(ctx, 'novelApp')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    novelApp: NovelAppService
  }
}

/** 命中含密钥入参的命令：recordInput 关闭，避免密钥进入会话日志（spec 4.3.2）。 */
const SECRET_INPUT_COMMANDS = new Set(['novel.admin.provider'])

function renderResult(result: unknown): CommandResult {
  if (result === undefined || result === null) return { kind: 'success' }
  return {
    kind: 'success',
    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  }
}

/** 解析 rawInput 并分发到共享服务层（命令行与 UI 调用同一入口，design 2.1.2 第 4 条）。 */
async function dispatchCommand(app: NovelHarnessApp, spec: CommandSpec, invocation: CommandInvocation): Promise<CommandResult> {
  try {
    const flags = parseFlags(invocation.rawInput)
    const args = coerceFlags(spec, flags)
    const result = await app.executeCommand(spec.name, { ...args, operator: 'dsh-command' })
    return renderResult(result)
  } catch (err) {
    return {
      kind: 'error',
      text: err instanceof Error ? err.message : String(err),
    }
  }
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const host = config.host ?? new DshHostAdapter(ctx, { dataRoot: config.dataRoot })
  const app = new NovelHarnessApp({
    host,
    dataRoot: config.dataRoot,
    stylePackRoot: config.stylePackRoot,
  })
  new NovelAppService(ctx, app)

  for (const spec of app.commands()) {
    ctx.commands.register({
      name: commandNameOf(spec.name),
      description: spec.description,
      input: { hint: usageOf(spec) },
      recordInput: !SECRET_INPUT_COMMANDS.has(spec.name),
      handler: (invocation) => dispatchCommand(app, spec, invocation),
    })
  }
}

export { NovelHarnessApp, FakeHost, DshHostAdapter }
export type { HostProvider } from './host/types.js'
export type { DshHostAdapterOptions } from './host/dsh-adapter.js'
