/**
 * 隔离章批量救回：改写 writer 绑定（如 glm-4.6 → glm-5.3）后，
 * 对全部隔离章执行正文级指导重生成（无意见按普通重生成，spec 5.9.1 规则 4）。
 * 新质量门（severe-only 阻断 + 风格包阈值）生效。
 * 运行：NOVEL_WRITER_MODEL=glm-5.3 + 三家密钥环境变量 npx tsx scripts/rescue-isolated.mts
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NovelHarnessApp } from '../src/app.js'
import { FakeHost } from '../src/host/dsh-adapter.js'
import type { ProjectConfig } from '../src/project/schema.js'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const MINIMAX_KEY = process.env.MINIMAX_API_KEY
const GLM_TOKEN = process.env.GLM_PLAN_TOKEN
const WRITER_MODEL = process.env.NOVEL_WRITER_MODEL ?? 'glm-5.3'
if (!DEEPSEEK_KEY || !MINIMAX_KEY || !GLM_TOKEN) {
  console.error('缺少环境变量：DEEPSEEK_API_KEY / MINIMAX_API_KEY / GLM_PLAN_TOKEN')
  process.exit(2)
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

const dataRoot = join(homedir(), '.dsh')
const state = JSON.parse(await readFile('D:/AiProject/novel-output/current-project.json', 'utf-8')) as { projectId: string }
const projectId = state.projectId
const projectJsonPath = join(dataRoot, 'novels', projectId, 'project.json')

// 1. 改 writer 绑定模型（bindings 不在创建后只读清单内）
const config = JSON.parse(await readFile(projectJsonPath, 'utf-8')) as ProjectConfig
const isolation = JSON.parse(await readFile(join(dataRoot, 'novels', projectId, 'state', 'isolation.json'), 'utf-8')) as {
  isolated: Array<{ chapter: number }>
}
const chapters = [...new Set(isolation.isolated.map((i) => i.chapter))].sort((a, b) => a - b)
const writer = config.bindings.find((b) => b.role === 'writer')
if (!writer) throw new Error('项目缺少 writer 绑定')
log(`writer 绑定：${writer.primary.model} → ${WRITER_MODEL}（fallback ${writer.fallbacks.map((f) => f.model).join(',')}）`)
writer.primary.model = WRITER_MODEL
await writeFile(projectJsonPath, JSON.stringify(config, null, 2), 'utf-8')

// 2. 注册服务商并触发批量重生成
const app = new NovelHarnessApp({ dataRoot, host: new FakeHost(dataRoot) })
await app.registerProvider({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_KEY, qps: 1 })
await app.registerProvider({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'https://api.minimax.chat/v1', apiKey: MINIMAX_KEY, qps: 1 })
await app.registerProvider({ providerId: 'glm', kind: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', planToken: GLM_TOKEN, channel: 'cn', qps: 1 })

log(`开始批量重生成隔离章：${chapters.join(',')}（共 ${chapters.length} 章）`)
const summary = (await app.executeCommand('novel.guidance.regen', {
  project: projectId,
  chapters,
  stage: 'content',
  operator: 'rescue',
})) as { results?: Array<{ chapter: number; success: boolean; message: string }> }

let ok = 0
for (const r of summary.results ?? []) {
  log(`第 ${r.chapter} 章：${r.success ? '✅ 过审成稿' : '❌ ' + r.message}`)
  if (r.success) ok++
}
const final = await app.projects.loadProject(projectId)
const status = await app.status(projectId)
log(`救援完成：${ok}/${chapters.length} 章救回；全书终稿 ${status.stages.final.done}/${status.stages.final.total}，项目状态 ${final.status}`)
const exported = await app.export(projectId, { allowGaps: true })
const bundleDir = (exported as { bundle?: { bundleDir?: string } }).bundle?.bundleDir
log(`交付包：${bundleDir}`)
process.exit(0)
