/**
 * 重启续传 + 指导重生成验证：新进程实例指向既有数据根目录，
 * 恢复已完成项目，对隔离章附加指导意见并触发章纲级重生成（spec 5.9）。
 * 运行：NOVEL_E2E_ROOT=<数据根> + 三家密钥环境变量 npx tsx scripts/e2e-regen.mts
 */
import { NovelHarnessApp } from '../src/app.js'
import { FakeHost } from '../src/host/dsh-adapter.js'
import { readdir } from 'node:fs/promises'

const root = process.env.NOVEL_E2E_ROOT
if (!root) {
  console.error('缺少 NOVEL_E2E_ROOT（上一轮 e2e 的数据根目录）')
  process.exit(2)
}
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const MINIMAX_KEY = process.env.MINIMAX_API_KEY
const GLM_TOKEN = process.env.GLM_PLAN_TOKEN

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

// 1. 模拟进程重启：全新实例指向既有磁盘数据
const app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root) })
await app.registerProvider({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_KEY!, qps: 1 })
await app.registerProvider({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'https://api.minimax.chat/v1', apiKey: MINIMAX_KEY!, qps: 1 })
await app.registerProvider({ providerId: 'glm', kind: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', planToken: GLM_TOKEN!, channel: 'cn', qps: 1 })

const novelsDir = `${root}/novels`
const projectId = (await readdir(novelsDir))[0]!
const before = await app.status(projectId)
log(`重启恢复项目 ${projectId}：终稿 ${before.stages?.final?.done ?? 0}/${before.stages?.final?.total}，隔离 ${before.chapters?.filter((c: { isolated: boolean }) => c.isolated).length ?? 0} 章`)

// 2. 对隔离的第 1 章附加指导意见（completed 态允许，spec 5.9.1 规则 8 的放宽面）
await app.executeCommand('novel.guidance.add', {
  project: projectId,
  chapter: 1,
  stage: 'outline',
  content: '开场不要用废墟回忆定调。第一幕直接写雪夜酒馆里的一场无声对峙：沈孤鸿听盲眼少女唱曲，唱到一半弦断，满堂寂静。以「断弦」为全章意象锚点，场景只在酒馆与长街两处切换。砍掉所有「七年前的那个雪夜」式闪回，旧案信息全部经由现场物件（一张烧焦的当票）透出。',
  operator: 'e2e-regen',
})
log('指导意见已附加（outline 阶段，第 1 章）')

// 3. 触发指导重生成（章纲级 → 通过后自动衔接正文）
const result = await app.executeCommand('novel.guidance.regen', { project: projectId, chapters: [1], stage: 'outline' })
log(`指导重生成结果：${JSON.stringify(result).slice(0, 300)}`)

// 4. 验证结果
const after = await app.status(projectId)
log(`重生成后：终稿 ${after.stages?.final?.done ?? 0}/${after.stages?.final?.total}`)
const proj = await app.projects.loadProject(projectId)
log(`项目状态：${proj.status}`)
const exported = await app.export(projectId, { allowGaps: true })
console.log('=== 全文头 400 字 ===')
console.log((exported as { compiled: { text?: string } }).compiled.text?.slice(0, 400))
process.exit(0)
