import { splitSentences } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

export const AI_JARGON_WORDS: readonly string[] = [
  '在他看来',
  '在他眼中',
  '仿佛在诉说',
  '仿佛在低语',
  '空气中弥漫着',
  '空气中凝固着',
  '岁月的沉淀',
  '时光的沉淀',
  '不禁让人',
  '令人窒息',
  '无声地诉说',
  '诉说着什么',
  '见证了',
  '承载了太多',
  '内心深处',
  '灵魂深处',
  '无法言喻',
  '难以名状',
  '只可意会',
  '不可言传',
  '眼神里闪过一丝',
  '眼中闪过一丝',
  '嘴角勾起一抹',
  '眼底掠过',
  '一丝不易察觉',
  '几不可察',
  '岁月静好',
  '诗和远方',
  '重新定义',
  '赋能',
  '底层逻辑',
  '认知升级',
  '情绪价值',
  '松弛感',
  '氛围感拉满',
  '一丝凉意',
  '一丝笑意',
  '一丝慌乱',
  '难以言喻',
  '说不清道不明',
  '莫名的',
  '空气仿佛凝固',
  '时间仿佛静止',
  '几乎不可闻',
  '几不可闻',
  '眸中',
  '眸底',
  '眼底闪过',
  '眼底浮现',
  '眼底一沉',
  '命运齿轮',
  '宿命的',
  '冥冥之中',
  '冥冥注定',
  '某种意义上',
  '某种程度上',
  '不知为何',
  '嘴角微微上扬',
  '唇角勾起',
  '轻勾唇角',
  '下一秒',
  '刹那间',
  '霎时间',
  '须臾之间',
  '深吸一口气',
  '眸光微动',
  '神色微变',
  '神色一动',
]

export function detectJargon(text: string): DeAiHit[] {
  const hits: DeAiHit[] = []
  const sentences = splitSentences(text)
  const seen = new Set<string>()
  for (const sentence of sentences) {
    for (const word of AI_JARGON_WORDS) {
      if (sentence.text.includes(word) && !seen.has(`${sentence.index}:${word}`)) {
        seen.add(`${sentence.index}:${word}`)
        hits.push({
          type: 'jargon',
          severity: 'severe',
          paragraph: -1,
          sentence: sentence.index + 1,
          excerpt: sentence.text.slice(0, 60),
          detail: { word },
        })
      }
    }
  }
  return hits
}