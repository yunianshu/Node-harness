export function charBigrams(text: string): Set<string> {
  const normalized = text.replace(/\s/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i++) {
    grams.add(normalized.slice(i, i + 2))
  }
  return grams
}

export function jaccardSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const ga = charBigrams(a)
  const gb = charBigrams(b)
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0
  let intersection = 0
  for (const g of ga) {
    if (gb.has(g)) intersection++
  }
  return intersection / (ga.size + gb.size - intersection)
}

export function duplicateParagraphRatio(paragraphs: string[]): { ratio: number; pairs: Array<[number, number]> } {
  const seen = new Map<string, number>()
  const pairs: Array<[number, number]> = []
  let duplicated = 0
  paragraphs.forEach((p, i) => {
    const key = p.replace(/\s/g, '')
    const first = seen.get(key)
    if (first !== undefined) {
      duplicated++
      pairs.push([first + 1, i + 1])
    } else {
      seen.set(key, i)
    }
  })
  const ratio = paragraphs.length === 0 ? 0 : duplicated / paragraphs.length
  return { ratio, pairs }
}

export function similarParagraphRatio(
  paragraphs: string[],
  threshold: number,
): { ratio: number; pairs: Array<[number, number, number]> } {
  const pairs: Array<[number, number, number]> = []
  const normalized = paragraphs.map((p) => p.replace(/\s/g, ''))
  let similarCount = 0
  const flagged = new Set<number>()
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (flagged.has(j)) continue
      const sim = jaccardSimilarity(normalized[i], normalized[j])
      if (sim >= threshold) {
        pairs.push([i + 1, j + 1, Number(sim.toFixed(2))])
        similarCount++
        flagged.add(j)
        break
      }
    }
  }
  const ratio = paragraphs.length === 0 ? 0 : similarCount / paragraphs.length
  return { ratio, pairs }
}