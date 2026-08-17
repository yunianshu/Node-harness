export interface SentenceSpan {
  text: string
  start: number
  end: number
  index: number
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export function splitSentences(text: string): SentenceSpan[] {
  const sentences: SentenceSpan[] = []
  const regex = /[^。！？!?；\n]+[。！？!?；]*/g
  let match: RegExpExecArray | null
  let index = 0
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    sentences.push({ text: trimmed, start: match.index, end: match.index + raw.length, index: index++ })
  }
  return sentences
}

export function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

export function locateParagraphOf(paragraphs: Array<{ start: number }>, offset: number, totalLength: number): number {
  for (let i = 0; i < paragraphs.length; i++) {
    const start = paragraphs[i].start
    const end = i + 1 < paragraphs.length ? paragraphs[i + 1].start : totalLength
    if (offset >= start && offset < end) return i + 1
  }
  return paragraphs.length
}