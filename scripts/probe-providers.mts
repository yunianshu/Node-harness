/** 三家服务商单调用探针：验证端点/模型/密钥，密钥仅经环境变量。 */
import { chatCompletion } from '../src/model/providers/openai-compat.js'

const targets = [
  { name: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', key: process.env.DEEPSEEK_API_KEY },
  { name: 'minimax', baseURL: 'https://api.minimaxi.chat/v1', model: 'MiniMax-M3', key: process.env.MINIMAX_API_KEY },
  { name: 'minimax-cn', baseURL: 'https://api.minimax.chat/v1', model: 'MiniMax-M3', key: process.env.MINIMAX_API_KEY },
  { name: 'glm-plan-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: process.env.GLM_MODEL ?? 'glm-4.6', key: process.env.GLM_PLAN_TOKEN },
]

for (const t of targets) {
  if (!t.key) continue
  const started = Date.now()
  try {
    const res = await chatCompletion({
      baseURL: t.baseURL,
      apiKey: t.key,
      model: t.model,
      messages: [{ role: 'user', content: '只回两个字：可用' }],
      params: { maxOutputTokens: 16 },
      timeoutMs: 60_000,
    })
    console.log(`OK   ${t.name} (${t.model}) ${Date.now() - started}ms -> ${JSON.stringify(res.content).slice(0, 60)} usage=${JSON.stringify(res.usage)}`)
  } catch (err) {
    console.log(`FAIL ${t.name} (${t.model}) ${Date.now() - started}ms -> ${err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)}`)
  }
}
