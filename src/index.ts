import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { NovelHarnessApp, type CommandSpec } from './app.js'
import { DshHostAdapter, FakeHost } from './host/dsh-adapter.js'
import type { HostProvider } from './host/types.js'
import { coerceFlags, commandNameOf, parseFlags, usageOf, type ParsedFlags } from './command-line.js'
import { attachProgressFeed, registerNovelSessionEvents, type SessionAppender } from './progress-feed.js'

export const name = 'novel-harness'

/** 依赖底座命令注册、凭据服务、用户提问服务与 LLM 服务（dsh-base 默认装载）。 */
export const inject = ['commands', 'credentials', 'userQuestions', 'llm']

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

/** 启动/恢复/查询类命令：成功后把发起会话绑定为进度推送目标（status 查询顺带刷新实时卡片）。 */
const FEED_COMMANDS = new Set(['novel.start', 'novel.resume', 'novel.regenerate', 'novel.guidance.regen', 'novel.status'])

function renderResult(result: unknown): CommandResult {
  if (result === undefined || result === null) return { kind: 'success' }
  return {
    kind: 'success',
    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  }
}

/** 命中缺省参数时向用户提问补全；无法补全（无 provider / 非 live agent / 未作答）返回 null。 */
async function fillMissingArgs(
  ctx: Context,
  app: NovelHarnessApp,
  spec: CommandSpec,
  flags: ParsedFlags,
  invocation: CommandInvocation,
): Promise<Record<string, string> | null> {
  const missing = spec.args.filter((a) => a.required && flags[a.key] === undefined)
  if (missing.length === 0) return null

  const questions: AskUserQuestionItem[] = []
  for (const arg of missing) {
    if (arg.key === 'project') {
      const projects = await app.projects.listProjects()
      if (projects.length === 0) {
        questions.push({
          id: 'project',
          question: '目前还没有任何小说项目，请先创建。',
          detail: '运行 novel-create 创建项目后再执行本命令。',
        })
      } else {
        questions.push({
          id: 'project',
          question: `选择要「${spec.description}」的小说项目`,
          options: projects.map((p) => ({ label: p.name, description: `${p.projectId} · ${p.status}` })),
        })
      }
    } else {
      questions.push({
        id: arg.key,
        question: `请提供「${arg.description}」`,
        detail: usageOf(spec),
      })
    }
  }

  let answer: AskUserQuestionAnswer
  try {
    answer = await ctx.userQuestions.ask({ questions, agent: invocation.agent, signal: invocation.signal })
  } catch (err) {
    // 底座无提问 provider 或 agent 非 live：回退到原始缺参报错
    console.error('[novel] fillMissingArgs 提问失败：', err)
    return null
  }

  const filled: Record<string, string> = {}
  for (const item of answer.answers) {
    if (item.selected.length === 0 && !item.custom) continue
    const value = item.custom ?? item.selected[0]
    if (argIsProject(item.id)) {
      const project = (await app.projects.listProjects()).find((p) => p.name === value)
      if (project) filled.project = project.projectId
    } else {
      filled[item.id] = value
    }
  }
  return Object.keys(filled).length > 0 ? filled : null
}

function argIsProject(key: string): boolean {
  return key === 'project'
}

/** 解析 rawInput 并分发到共享服务层（命令行与 UI 调用同一入口，design 2.1.2 第 4 条）。 */
async function dispatchCommand(
  ctx: Context,
  app: NovelHarnessApp,
  spec: CommandSpec,
  invocation: CommandInvocation,
  onFeed: (session: SessionAppender, projectId: string) => void,
): Promise<CommandResult> {
  try {
    const flags = parseFlags(invocation.rawInput)
    let args: Record<string, unknown>
    try {
      args = coerceFlags(spec, flags)
    } catch (err) {
      const filled = await fillMissingArgs(ctx, app, spec, flags, invocation)
      if (filled === null) throw err
      args = coerceFlags(spec, { ...flags, ...filled })
    }
    const result = await app.executeCommand(spec.name, { ...args, operator: 'dsh-command' })
    if (FEED_COMMANDS.has(spec.name) && typeof args.project === 'string' && args.project.length > 0) {
      onFeed(invocation.agent.session as SessionAppender, args.project)
    }
    return renderResult(result)
  } catch (err) {
    return {
      kind: 'error',
      text: err instanceof Error ? err.message : String(err),
    }
  }
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  // 启动即注册会话事件类型：会话回读可能先于任何 novel 命令发生
  void registerNovelSessionEvents()
  const host = config.host ?? new DshHostAdapter(ctx, { dataRoot: config.dataRoot })
  const app = new NovelHarnessApp({
    host,
    dataRoot: config.dataRoot,
    stylePackRoot: config.stylePackRoot,
  })
  new NovelAppService(ctx, app)

  /** 进度供给随插件 fiber 生命周期释放（会话级绑定在 attach 时登记）。 */
  const detachFeeds = new Set<() => void>()
  const onFeed = (session: SessionAppender, projectId: string): void => {
    const detach = attachProgressFeed(app, session, projectId)
    detachFeeds.add(detach)
    ctx.effect(() => {
      return () => {
        detach()
        detachFeeds.delete(detach)
      }
    })
  }

  for (const spec of app.commands()) {
    ctx.commands.register({
      name: commandNameOf(spec.name),
      description: spec.description,
      input: { hint: usageOf(spec) },
      recordInput: !SECRET_INPUT_COMMANDS.has(spec.name),
      handler: (invocation) => dispatchCommand(ctx, app, spec, invocation, onFeed),
    })
  }
}

export { NovelHarnessApp, FakeHost, DshHostAdapter }
export type { HostProvider } from './host/types.js'
export type { DshHostAdapterOptions } from './host/dsh-adapter.js'
