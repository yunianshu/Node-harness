import type { DeAiHit } from './checker.js'

/**
 * 检测正文中的英文残留（writer 偶发混入 "transactions completed." 这类污染，
 * 破坏中文叙事语境，是明显的生成痕迹）。连续 ≥5 个 ASCII 字母即命中 severe。
 */
export function detectForeignText(text: string): DeAiHit[] {
  const hits: DeAiHit[] = []
  const re = /[A-Za-z]{5,}/g
  const paragraphs = text.split(/\n/)
  for (let i = 0; i < paragraphs.length; i++) {
    let m: RegExpExecArray | null
    while ((m = re.exec(paragraphs[i])) !== null) {
      hits.push({
        type: 'foreign-text',
        severity: 'severe',
        paragraph: i + 1,
        excerpt: m[0],
        detail: { word: m[0] },
      })
    }
  }
  return hits
}
