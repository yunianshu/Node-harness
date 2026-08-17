const TEMPLATES: Array<(i: number) => string> = [
  (i) => `街角第${i}家的灯还亮着，掌柜的在打烊前擦最后一张桌子。`,
  (i) => `第${i}个刀客推门进来，带进一阵化不开的冷风，屋里的人停了筷。`,
  (i) => `他在城外第${i}棵老树下停了停，雪从枝头滑下来，落进衣领。`,
  (i) => `镖局第${i}次点了人数，少一个，谁也没有再提那个名字。`,
  (i) => `她把第${i}封信折好塞进袖口，抬头时神色如常，像什么都没发生。`,
  (i) => `酒是第${i}坛，开封的时候香气惊动了半条巷子的狗。`,
  (i) => `第${i}次更鼓敲过之后，长街上只剩他一个人的脚步声。`,
  (i) => `那口井在第${i}年冬天封了，井沿的绳痕还深得像刀刻。`,
  (i) => `账本翻到第${i}页，掌柜的手停住了，烛火跳了一下。`,
  (i) => `第${i}场雪落下来的时候，他终于承认自己老了。`,
  (i) => `桥头的第${i}级石阶裂了缝，缝里长出一根枯草。`,
  (i) => `第${i}拨追兵在渡口停住，河面起了大雾，什么也看不见。`,
]

const FILLER = [
  '他把刀放在桌上。',
  '没有人说话。',
  '雪停了。',
  '第三天。',
  '茶凉了。',
  '刀还在。',
  '他笑了笑。',
]

let counter = 0

export function resetCounter(): void {
  counter = 0
}

export function nextSentence(): string {
  const sentence = counter % 4 === 3 ? FILLER[Math.floor(counter / 4) % FILLER.length] : TEMPLATES[counter % TEMPLATES.length](counter + 1)
  counter++
  return sentence
}

export function diverseParagraphText(paragraphCount: number, minWords: number): string {
  const paragraphs: string[] = []
  let total = 0
  let p = 0
  while (total < minWords || p < paragraphCount) {
    const sentenceCount = 2 + ((p * 3) % 5)
    const chunk: string[] = []
    for (let s = 0; s < sentenceCount; s++) chunk.push(nextSentence())
    const words = chunk.join('').length
    paragraphs.push(chunk.join(''))
    total += words
    p++
    if (p > 500) break
  }
  return paragraphs.join('\n')
}

export function diverseText(minWords: number): string {
  const parts: string[] = []
  let words = 0
  while (words < minWords) {
    const s = nextSentence()
    parts.push(s)
    words += s.length
  }
  return parts.join('')
}
