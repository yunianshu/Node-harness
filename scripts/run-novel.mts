/**
 * 正式长篇项目运行器（30 章全本）。
 * - 数据根固定 ~/.dsh/novels（持久化，非临时目录）
 * - 断点续传：重复执行本脚本自动续跑既有项目（状态存 novel-output/current-project.json）
 * - 进程崩溃/中断后重跑同一命令即可恢复；密钥仅经环境变量
 * 运行：DEEPSEEK_API_KEY=... MINIMAX_API_KEY=... GLM_PLAN_TOKEN=... npx tsx scripts/run-novel.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NovelHarnessApp } from '../src/app.js'
import { FakeHost } from '../src/host/dsh-adapter.js'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const MINIMAX_KEY = process.env.MINIMAX_API_KEY
const GLM_TOKEN = process.env.GLM_PLAN_TOKEN
if (!DEEPSEEK_KEY || !MINIMAX_KEY || !GLM_TOKEN) {
  console.error('缺少环境变量：DEEPSEEK_API_KEY / MINIMAX_API_KEY / GLM_PLAN_TOKEN')
  process.exit(2)
}

// layout.projectPaths 会自行追加 novels 子目录，这里给到 .dsh 根
const DATA_ROOT = join(homedir(), '.dsh')
const OUT_DIR = 'D:/AiProject/novel-output'
const STATE_FILE = join(OUT_DIR, 'current-project.json')
const PROJECT_NAME = '雪夜刀声全本'
const TOTAL_CHAPTERS = 30
const POLL_MS = 60_000
const DEADLINE_MS = 12 * 60 * 60 * 1000

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

mkdirSync(OUT_DIR, { recursive: true })
const app = new NovelHarnessApp({ dataRoot: DATA_ROOT, host: new FakeHost(DATA_ROOT) })

async function registerProviders(): Promise<void> {
  await app.registerProvider({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_KEY!, qps: 1 })
  await app.registerProvider({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'https://api.minimax.chat/v1', apiKey: MINIMAX_KEY!, qps: 1 })
  await app.registerProvider({ providerId: 'glm', kind: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', planToken: GLM_TOKEN!, channel: 'cn', qps: 1 })
}

async function resolveProjectId(): Promise<string> {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as { projectId: string }
    if (existsSync(join(DATA_ROOT, state.projectId, 'project.json'))) {
      log(`续跑既有项目：${state.projectId}`)
      return state.projectId
    }
    log('状态文件指向的项目不存在，重新创建')
  }
  const created = await app.projects.create({
    name: PROJECT_NAME,
    premise: [
      '民国十二年至十五年间，北地边城「朔风城」。退役捕快沈孤鸿为查清七年前沈家灭门旧案重回故地。',
      '明线三案递进：当铺密室失窃、城防营管带赵铁山遇刺、知县离奇自缢，三案环环指向当年旧案真凶。',
      '暗线二人：酒馆盲眼歌女阿筝（旧案幸存者，耳力过人能辨声断案）与游方郎中白惜年（旧案验尸人，握有半张烧焦的当票）。',
      '对立面：赵铁山背后是从关外走私军火的「黑水商路」，旧案是灭口。',
      '风格冷硬克制，短句白描，暴力克制而突然，对话极简极深。',
      '结局留白：真相大白之日，官府卷宗被焚，沈孤鸿放下刀，将断弦琴留在阿筝坟前，独自出城。',
    ].join(''),
    totalChapters: TOTAL_CHAPTERS,
    stylePackId: 'gulong',
    gates: { outlineGate: 6.5, draftGate: 6.0 },
    bindings: [
      { role: 'planner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.6, maxOutputTokens: 8192 },
      { role: 'outliner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.7, maxOutputTokens: 8192 },
      { role: 'outline-reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.3, maxOutputTokens: 4096 },
      { role: 'writer', primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'glm-plan-cn' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.9, maxOutputTokens: 8192 },
      { role: 'reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.3, maxOutputTokens: 4096 },
      { role: 'archivist', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.3, maxOutputTokens: 4096 },
    ],
  }, 'run-novel')
  writeFileSync(STATE_FILE, JSON.stringify({ projectId: created.project.projectId, name: PROJECT_NAME, startedAt: new Date().toISOString() }, null, 2))
  log(`新项目创建：${created.project.projectId}（${TOTAL_CHAPTERS} 章，风格包 gulong）`)
  return created.project.projectId
}

await registerProviders()
const projectId = await resolveProjectId()
await app.startProject(projectId)
log('流水线已启动（断点续传由 ResumeScanner 兜底）')

const deadline = Date.now() + DEADLINE_MS
let lastLine = ''
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS))
  const proj = await app.projects.loadProject(projectId)
  const status = await app.status(projectId)
  const line = `${proj.status} | 章纲${status.stages.outline.done}/${status.stages.outline.total} 初稿${status.stages.draft.done}/${status.stages.draft.total} 终稿${status.stages.final.done}/${status.stages.final.total} | 隔离${status.chapters.filter((c) => c.isolated).map((c) => c.chapter).join(',') || '无'}`
  if (line !== lastLine) {
    log(line)
    lastLine = line
  }
  if (proj.status === 'completed' || proj.status === 'aborted' || proj.status === 'paused') {
    log(`流水线结束：${proj.status}`)
    break
  }
}

const final = await app.projects.loadProject(projectId)
log(`最终状态：${final.status}`)
if (final.status === 'completed') {
  const report = await app.report(projectId)
  const exported = await app.export(projectId, { allowGaps: true })
  const bundleDir = (exported as { bundle?: { bundleDir?: string } }).bundle?.bundleDir
  log(`交付包：${bundleDir ?? '（导出失败，可重跑导出）'}`)
  log(`完成 ${report.finalCount}/${TOTAL_CHAPTERS} 章，总字数 ${report.totalWords}，隔离章 ${report.isolatedChapters.join(',') || '无'}，平均评分 ${report.averageScore ?? '—'}`)
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Record<string, unknown>
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, finishedAt: new Date().toISOString(), status: final.status, bundleDir }, null, 2))
}
process.exit(final.status === 'completed' ? 0 : 1)
