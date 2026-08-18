/**
 * 引擎降底色对照样本生成（阶段1④）：
 * - 样本A：新引擎（节奏两级检查 + burstiness 提示约束 + 扩充词表），writer 温度 0.9，2 章
 * - 样本B：同引擎，writer 温度 0.95，1 章（温度 A/B；1.05 实测输出不稳——v3 混繁体、多轮字数超限被隔离，故降至 0.95）
 * 产出送 D:/AiProject/novel-output/检测样本/ 供朱雀/GPTZero 人工检测对比（基线：雪夜刀声全书 85%）。
 * 运行：三家密钥环境变量 npx tsx scripts/sample-humanize.mts
 */
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NovelHarnessApp } from '../src/app.js'
import { FakeHost } from '../src/host/dsh-adapter.js'
import type { ProjectConfig } from '../src/project/schema.js'

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

const OUT_DIR = 'D:/AiProject/novel-output/检测样本'
const dataRoot = join(homedir(), '.dsh')

async function runSample(label: string, chapters: number, temperature: number): Promise<string[]> {
  // 清理同名旧项目（检测样本为一次性产物，重跑需全新生成）
  const novelsRoot = join(dataRoot, 'novels')
  for (const name of await readdir(novelsRoot).catch(() => [])) {
    if (name.startsWith(`检测样本${label}`)) {
      await rm(join(novelsRoot, name), { recursive: true, force: true })
    }
  }
  const app = new NovelHarnessApp({ dataRoot, host: new FakeHost(dataRoot) })
  await app.registerProvider({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_KEY!, qps: 1 })
  await app.registerProvider({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'https://api.minimax.chat/v1', apiKey: MINIMAX_KEY!, qps: 1 })
  await app.registerProvider({ providerId: 'glm', kind: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', planToken: GLM_TOKEN!, channel: 'cn', qps: 1 })

  const created = await app.projects.create({
    name: `检测样本${label}`,
    premise: [
      '民国年间，漠北官道。老镖师沈铁衣押一口黑棺南下，雇主要求十五日内到风陵渡，途中棺不离人。',
      '一路上各方人等接连试探：想开棺的、想劫镖的、想打听棺中人的。棺上七道铜钉，钉钉咬血。',
      '只有沈铁衣知道棺材是空的。可越往南走，追的人越多，他越明白：空棺本身就是要送的东西。',
      '风格冷硬克制，短句与长句大开大合，暴力克制而突然。',
    ].join(''),
    totalChapters: chapters,
    stylePackId: 'gulong',
    gates: { outlineGate: 6.5, draftGate: 6.0 },
    bindings: [
      { role: 'planner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.6, maxOutputTokens: 8192 },
      { role: 'outliner', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.7, maxOutputTokens: 8192 },
      { role: 'outline-reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.3, maxOutputTokens: 8192 },
      { role: 'writer', primary: { providerId: 'glm', model: 'glm-5.3', accessMode: 'glm-plan-cn' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature, maxOutputTokens: 8192 },
      { role: 'reviewer', primary: { providerId: 'minimax', model: 'MiniMax-M3' }, fallbacks: [{ providerId: 'deepseek', model: 'deepseek-chat' }], temperature: 0.3, maxOutputTokens: 8192 },
      { role: 'archivist', primary: { providerId: 'deepseek', model: 'deepseek-chat' }, fallbacks: [], temperature: 0.3, maxOutputTokens: 4096 },
    ],
  }, 'sample')
  const projectId = created.project.projectId
  log(`样本${label}（温度 ${temperature}，${chapters} 章）：${projectId}`)
  await app.startProject(projectId)

  const deadline = Date.now() + 90 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000))
    const proj = await app.projects.loadProject(projectId)
    const st = await app.status(projectId)
    log(`样本${label}: ${proj.status} 终稿${st.stages.final.done}/${st.stages.final.total} 隔离${st.chapters.filter((c) => c.isolated).map((c) => c.chapter).join(',') || '无'}`)
    if (proj.status === 'completed' || proj.status === 'aborted' || proj.status === 'paused') break
  }
  const finals: string[] = []
  for (let ch = 1; ch <= chapters; ch++) {
    try {
      finals.push(await readFile(join(dataRoot, 'novels', projectId, 'chapters', 'final', `chapter_${String(ch).padStart(4, '0')}.txt`), 'utf-8'))
    } catch {
      finals.push('（该章未成稿）')
    }
  }
  return finals
}

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

const a = await runSample('A', 2, 0.9)
await (await import('node:fs/promises')).writeFile(join(OUT_DIR, '样本A_新引擎_温度0.9_第1章.txt'), a[0], 'utf-8')
await (await import('node:fs/promises')).writeFile(join(OUT_DIR, '样本A_新引擎_温度0.9_第2章.txt'), a[1], 'utf-8')

const b = await runSample('B', 1, 0.95)
await (await import('node:fs/promises')).writeFile(join(OUT_DIR, '样本B_新引擎_温度1.05_第1章.txt'), b[0], 'utf-8')

log(`全部样本已导出：${OUT_DIR}`)
process.exit(0)
