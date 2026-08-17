export class JsonParseError extends Error {
  readonly code = 'JSON_PARSE'
  constructor(message: string) {
    super(message)
    this.name = 'JsonParseError'
  }
}

export function extractJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim())
    } catch {
      continue
    }
  }
  throw new JsonParseError('LLM 返回中未找到可解析 JSON')
}