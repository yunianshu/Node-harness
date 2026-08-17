/**
 * 真实模型端到端验证（tasks.md 10.4）：三家服务商按角色路由，3 章全流程。
 * 密钥仅从环境变量读取：DEEPSEEK_API_KEY / MINIMAX_API_KEY / GLM_PLAN_TOKEN，
 * 不落盘、不打印、不入审计。
 * 运行：npx tsx scripts/e2e-real.mts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

const root = mkdtempSync(join(tmpdir(), 'novel-e2e-real-'))
log(`数据根目录：${root}`)
const app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root) })

// 1. 注册三家服务商（角色路由目标）
await app.registerProvider({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_KEY, qps: 1 })
await app.registerProvider({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'https://api.minimax.chat/v1', apiKey: MINIMAX_KEY, qps: 1 })
await app.registerProvider({ providerId: 'glm', kind: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', planToken: GLM_TOKEN, channel: 'cn', qps: 1 })
log('服务商注册完成：deepseek / minimax / glm(coding-plan-cn)')

// 2. 创建项目：DeepSeek 规划 + GLM 写作 + MiniMax 审查（多模型协作）
const created = await app.projects.create({
  name: '雪夜刀声',
  premise: [
    '民国十二年，北地边城。退役捕快沈孤鸿重出江湖，只为查清七年前灭门旧案的真相。',
    '线索指向当年同僚如今的城防营管带，而唯一的人证，是个在酒馆卖唱的盲眼少女。',
    '风格冷硬克制，短句白描， violence 克制而突然。结局留白：真相大白之日，主角放下刀。',
  ].join(''),
  totalChapters: 3,
  stylePackId: 'gulong',
  structured: { minWords: 1200, maxWords: 2200, hardFloorWords: 900, minParagraphs: 10 },
  gates: { outlineGate: 7.0, draftGate: 6.0, draftRewriteLimit: 2 },
  bindings: [
    { role: 'planner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.6, maxOutputTokens: 8192 },
    { role: 'outliner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.7, maxOutputTokens: 8192 },
    { role: 'outline-reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [], temperature: 0.3, maxOutputTokens: 4096 },
    { role: 'writer', primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'glm-plan-cn' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.9, maxOutputTokens: 8192 },
    { role: 'reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [], temperature: 0.3, maxOutputTokens: 4096 },
    { role: 'archivist', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.3, maxOutputTokens: 4096 },
  ],
}, 'e2e-real')
log(`项目创建：${created.project.projectId}（风格包 gulong）`)

// 3. 启动并轮询进度
const eventsSeen = new Map<string, number>()
const watch = setInterval(() => {
  const tail = app.events.slice(-3)
  for (const e of tail) {
    const t = String(e.type)
    eventsSeen.set(t, (eventsSeen.get(t) ?? 0) + 1)
  }
}, 2000)

await app.startProject(created.project.projectId)
log('流水线已启动，轮询进度…')

const deadline = Date.now() + 55 * 60 * 1000
let lastLine = ''
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000))
  const status = await app.status(created.project.projectId)
  const line = JSON.stringify(status.summary ?? status)
  if (line !== lastLine) {
    log(`进度：${line}`)
    lastLine = line
  }
  const proj = await app.projects.loadProject(created.project.projectId)
  if (proj.status === 'completed' || proj.status === 'aborted' || proj.status === 'paused') {
    log(`流水线结束：${proj.status}`)
    break
  }
}
clearInterval(watch)

// 4. 报告与导出
const projectId = created.project.projectId
const finalProject = await app.projects.loadProject(projectId)
log(`最终状态：${finalProject.status}`)
const report = await app.report(projectId)
console.log('=== 总结报告 ===')
console.log(JSON.stringify(report, null, 2))
const channelStatus = app.gateway.channelStatus()
console.log('=== 通道状态 ===')
console.log(JSON.stringify(channelStatus, null, 2))
const exported = await app.export(projectId, { allowGaps: true })
console.log('=== 导出结果 ===')
console.log(JSON.stringify(exported, null, 2).slice(0, 2000))
console.log('=== 事件计数（尾部样本） ===')
console.log(JSON.stringify([...eventsSeen.entries()], null, 2))
process.exit(finalProject.status === 'completed' ? 0 : 1)
