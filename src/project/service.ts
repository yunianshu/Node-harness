import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { HostProvider } from '../host/types.js'
import { AuditLog } from '../storage/audit.js'
import { atomicWriteFile, atomicWriteJson, readJsonValidated } from '../storage/atomic.js'
import { ensureProjectLayout, novelsRoot, projectPaths } from '../storage/layout.js'
import {
  DEFAULT_STYLE_PACK,
  PREMISE_WARN_MIN_LENGTH,
  ModelBinding,
  ProjectConfig,
  ProjectConfigSchema,
  ProjectCreateInput,
  ProjectCreateInputSchema,
} from './schema.js'
import { DSL_PROVIDER } from '../model/registry.js'
import { InvalidStateError, transition } from './state-machine.js'

export type ProjectErrorCode =
  | 'PREMISE_EMPTY'
  | 'NAME_DUP'
  | 'NAME_INVALID'
  | 'CHAPTER_RANGE'
  | 'STYLE_PACK_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_CORRUPTED'
  | 'ALREADY_RUNNING'
  | 'PROJECT_IMMUTABLE'
  | 'INVALID_STATE'

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode | (string & {}),
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ProjectError'
  }
}

export interface LockFile {
  pid: number
  startedAt: string
  projectId: string
}

export interface ProjectServiceDeps {
  host: HostProvider
  listStylePacks(): Promise<string[]>
}

export interface CreateResult {
  project: ProjectConfig
  warnings: string[]
}

export interface RegenerateTicket {
  projectId: string
  chapters: number[]
  queuedAt: string
  message: string
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 未显式绑定模型时的默认 dsh 底座模型绑定（模型 = dsh settings.yaml 注册的 provider route）。
 * 角色 → 主模型/降级链；writer 放大输出预算规避推理模型思考段截断。
 */
export function defaultDshBindings(): ModelBinding[] {
  // dsh 绑定不经 registry 三元校验（accessMode 仅 schema 占位，语义由 DSL_PROVIDER 覆盖）
  const ref = (model: string): ModelBinding['primary'] => ({
    providerId: DSL_PROVIDER,
    model,
    accessMode: 'pay-as-you-go',
  })
  return [
    { role: 'planner', primary: ref('zai-coding-cn/glm-5.2'), fallbacks: [ref('hprt/glm-5.1')], temperature: 0.6, maxOutputTokens: 8192, fallbackThreshold: 5 },
    { role: 'outliner', primary: ref('zai-coding-cn/glm-5.2'), fallbacks: [ref('hprt/glm-5.1')], temperature: 0.7, maxOutputTokens: 8192, fallbackThreshold: 5 },
    { role: 'outline-reviewer', primary: ref('zai-coding-cn/glm-5.1'), fallbacks: [ref('hprt/deepseek-v4-flash')], temperature: 0.3, maxOutputTokens: 8192, fallbackThreshold: 5 },
    { role: 'writer', primary: ref('zai-coding-cn/glm-5.2'), fallbacks: [ref('hprt/glm-5.1')], temperature: 0.9, maxOutputTokens: 16384, fallbackThreshold: 5 },
    { role: 'reviewer', primary: ref('zai-coding-cn/glm-5.1'), fallbacks: [ref('hprt/deepseek-v4-flash')], temperature: 0.3, maxOutputTokens: 8192, fallbackThreshold: 5 },
    { role: 'archivist', primary: ref('zai-coding-cn/glm-4.7'), fallbacks: [], temperature: 0.3, maxOutputTokens: 4096, fallbackThreshold: 5 },
  ]
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  private async dataRoot(): Promise<string> {
    return this.deps.host.storage.dataRoot()
  }

  async create(input: ProjectCreateInput, operator = 'cli'): Promise<CreateResult> {
    const parsed = ProjectCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const map: Record<string, ProjectErrorCode> = {
        name: issue.path[0] === 'name' ? 'NAME_INVALID' : 'NAME_INVALID',
        premise: 'PREMISE_EMPTY',
        totalChapters: 'CHAPTER_RANGE',
      }
      const field = String(issue.path[0] ?? '')
      throw new ProjectError(
        map[field] ?? 'CHAPTER_RANGE',
        issue.message,
        { field, issues: parsed.error.issues },
      )
    }
    const clean = parsed.data
    const warnings: string[] = []

    const dataRoot = await this.dataRoot()
    const existing = await this.listProjects()
    if (existing.some((p) => p.name === clean.name)) {
      throw new ProjectError('NAME_DUP', `项目名称已存在：${clean.name}`)
    }

    const availablePacks = await this.deps.listStylePacks()
    let stylePackId = clean.stylePackId
    if (!stylePackId) {
      stylePackId = DEFAULT_STYLE_PACK
      warnings.push(`未显式选择风格包，已自动绑定「${DEFAULT_STYLE_PACK}」`)
    } else if (!availablePacks.includes(stylePackId)) {
      throw new ProjectError('STYLE_PACK_NOT_FOUND', `风格包不存在，可选：${availablePacks.join(' / ')}`, {
        available: availablePacks,
      })
    }

    if (clean.premise.length < PREMISE_WARN_MIN_LENGTH) {
      warnings.push('故事前提较短，建议补充世界观、核心冲突与结局走向')
    }

    const now = new Date().toISOString()
    const projectId = `${clean.name}-${randomUUID().slice(0, 8)}`
    // 未显式绑定模型时自动绑定 dsh 底座模型（聊天式创建开箱即用，无需注册外部服务商）
    const bindings = clean.bindings ?? defaultDshBindings()
    if (!clean.bindings) {
      warnings.push('未显式绑定模型，已自动绑定 dsh 底座模型（可在命令中调整角色模型/温度）')
    }
    const config: ProjectConfig = ProjectConfigSchema.parse({
      projectId,
      name: clean.name,
      totalChapters: clean.totalChapters,
      stylePackId,
      premiseSha256: createHash('sha256').update(clean.premise, 'utf-8').digest('hex'),
      premiseLength: clean.premise.length,
      gates: clean.gates ?? {},
      structured: clean.structured ?? {},
      aiFlavor: clean.aiFlavor ?? {},
      scheduling: clean.scheduling ?? {},
      retry: clean.retry ?? {},
      bindings,
      status: 'pending',
      webhookUrl: clean.webhookUrl ?? '',
      createdAt: now,
      updatedAt: now,
    })

    const paths = projectPaths(dataRoot, projectId)
    await ensureProjectLayout(paths)
    await atomicWriteJson(paths.projectJson, config)
    await atomicWriteFile(paths.premiseTxt, clean.premise)
    await this.auditFor(projectId, operator, 'project.create', { name: clean.name, totalChapters: clean.totalChapters, stylePackId })

    return { project: config, warnings }
  }

  async loadProject(projectId: string): Promise<ProjectConfig> {
    const dataRoot = await this.dataRoot()
    const raw = await readJsonValidated<unknown>(projectPaths(dataRoot, projectId).projectJson)
    if (raw === null) {
      const entries = await readdir(novelsRoot(dataRoot), { withFileTypes: true })
        .then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name))
        .catch(() => [] as string[])
      if (!entries.includes(projectId)) throw new ProjectError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
      throw new ProjectError('PROJECT_CORRUPTED', `project.json 损坏：${projectId}`)
    }
    const parsed = ProjectConfigSchema.safeParse(raw)
    if (!parsed.success) throw new ProjectError('PROJECT_CORRUPTED', 'project.json 结构不合法', { issues: parsed.error.issues })
    return parsed.data
  }

  async listProjects(): Promise<ProjectConfig[]> {
    const dataRoot = await this.dataRoot()
    let ids: string[] = []
    try {
      const entries = await readdir(novelsRoot(dataRoot), { withFileTypes: true })
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
    const projects: ProjectConfig[] = []
    for (const id of ids) {
      const raw = await readJsonValidated<unknown>(projectPaths(dataRoot, id).projectJson)
      if (raw === null) continue
      const parsed = ProjectConfigSchema.safeParse(raw)
      if (parsed.success) projects.push(parsed.data)
    }
    return projects
  }

  async readPremise(projectId: string): Promise<string> {
    const dataRoot = await this.dataRoot()
    try {
      return await readFile(projectPaths(dataRoot, projectId).premiseTxt, 'utf-8')
    } catch {
      throw new ProjectError('PROJECT_NOT_FOUND', `premise.txt 不存在：${projectId}`)
    }
  }

  private async saveProject(config: ProjectConfig): Promise<void> {
    const dataRoot = await this.dataRoot()
    await atomicWriteJson(projectPaths(dataRoot, config.projectId).projectJson, {
      ...config,
      updatedAt: new Date().toISOString(),
    })
  }

  private async auditFor(projectId: string, operator: string, action: string, detail?: Record<string, unknown>): Promise<void> {
    const dataRoot = await this.dataRoot()
    await new AuditLog(projectPaths(dataRoot, projectId).logs.auditLog).append(operator, action, detail)
  }

  private async acquireLock(projectId: string): Promise<void> {
    const dataRoot = await this.dataRoot()
    const lockPath = projectPaths(dataRoot, projectId).state.pipelineLock
    const existing = await readJsonValidated<unknown>(lockPath)
    if (existing) {
      const lock = existing as LockFile
      if (isPidAlive(lock.pid)) {
        throw new ProjectError('ALREADY_RUNNING', `项目已在运行中（PID ${lock.pid}，启动于 ${lock.startedAt}）`)
      }
    }
    const lock: LockFile = { pid: process.pid, startedAt: new Date().toISOString(), projectId }
    await atomicWriteJson(lockPath, lock)
  }

  async releaseLock(projectId: string): Promise<void> {
    const dataRoot = await this.dataRoot()
    const lockPath = projectPaths(dataRoot, projectId).state.pipelineLock
    try {
      const raw = JSON.parse(await readFile(lockPath, 'utf-8')) as LockFile
      if (raw.pid === process.pid) await writeFile(lockPath, '', 'utf-8')
      else if (isPidAlive(raw.pid)) return
      else await writeFile(lockPath, '', 'utf-8')
    } catch {
      /* no lock to release */
    }
  }

  private async act(
    projectId: string,
    action: 'start' | 'pause' | 'resume' | 'stop' | 'planning-done' | 'complete',
    operator: string,
  ): Promise<ProjectConfig> {
    const config = await this.loadProject(projectId)
    let next
    try {
      next = transition(config.status, action)
    } catch (err) {
      if (err instanceof InvalidStateError) {
        throw new ProjectError('INVALID_STATE', err.message, { from: err.from, action: err.action })
      }
      throw err
    }
    const updated = { ...config, status: next }
    await this.saveProject(updated)
    await this.auditFor(projectId, operator, `project.${action}`, { from: config.status, to: next })
    return updated
  }

  async start(projectId: string, operator = 'cli'): Promise<ProjectConfig> {
    const config = await this.loadProject(projectId)
    await this.acquireLock(projectId)
    if (config.status !== 'pending' && config.status !== 'paused') {
      throw new ProjectError('INVALID_STATE', `仅待启动/已暂停项目可启动，当前状态：${config.status}`)
    }
    return this.act(projectId, config.status === 'pending' ? 'start' : 'resume', operator)
  }

  async pause(projectId: string, operator = 'cli'): Promise<ProjectConfig> {
    return this.act(projectId, 'pause', operator)
  }

  async resume(projectId: string, operator = 'cli'): Promise<ProjectConfig> {
    return this.act(projectId, 'resume', operator)
  }

  async stop(projectId: string, operator = 'cli'): Promise<ProjectConfig> {
    const updated = await this.act(projectId, 'stop', operator)
    await this.releaseLock(projectId)
    return updated
  }

  async markPlanningDone(projectId: string): Promise<ProjectConfig> {
    return this.act(projectId, 'planning-done', 'system')
  }

  async markComplete(projectId: string): Promise<ProjectConfig> {
    const updated = await this.act(projectId, 'complete', 'system')
    await this.releaseLock(projectId)
    return updated
  }

  async updatePremise(projectId: string, _newPremise: string): Promise<never> {
    const config = await this.loadProject(projectId)
    if (config.status !== 'pending') {
      throw new ProjectError('PROJECT_IMMUTABLE', '生成过程中禁止修改故事前提与总章数，请新建项目')
    }
    throw new ProjectError('PROJECT_IMMUTABLE', 'premise 与总章数创建后只读，请新建项目')
  }

  async updateBindings(projectId: string, bindings: ProjectConfig['bindings'], operator = 'admin'): Promise<ProjectConfig> {
    const config = await this.loadProject(projectId)
    const updated = { ...config, bindings }
    const parsed = ProjectConfigSchema.safeParse(updated)
    if (!parsed.success) throw new ProjectError('CHAPTER_RANGE', '绑定配置不合法', { issues: parsed.error.issues })
    await this.saveProject(parsed.data)
    await this.auditFor(projectId, operator, 'binding.change', { count: bindings.length })
    return parsed.data
  }

  async regenerate(
    projectId: string,
    chapters: number[],
    _overrides?: Record<string, unknown>,
    operator = 'cli',
  ): Promise<RegenerateTicket> {
    const config = await this.loadProject(projectId)
    const invalid = chapters.filter((c) => c < 1 || c > config.totalChapters)
    if (invalid.length > 0) throw new ProjectError('CHAPTER_RANGE', `章节号超出范围：${invalid.join(',')}`)
    await this.auditFor(projectId, operator, 'chapter.regenerate', { chapters })
    return {
      projectId,
      chapters: [...new Set(chapters)].sort((a, b) => a - b),
      queuedAt: new Date().toISOString(),
      message: `已登记重生成请求：${chapters.join(',')}`,
    }
  }
}

export { ProjectCreateInputSchema, ProjectCreateInputSchema as CreateInputSchema }
export const LockFileSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
  projectId: z.string(),
})