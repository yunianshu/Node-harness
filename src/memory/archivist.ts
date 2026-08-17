import type { ModelGateway } from '../model/gateway.js'
import type { SceneRef, SpacetimeEntry } from './matrix-store.js'

export interface ArchivistInput {
  chapter: number
  finalText: string
  locationNames: string[]
  projectId: string
}

export type ArchivistOutcome =
  | { kind: 'extracted'; entry: SpacetimeEntry }
  | { kind: 'pending-manual'; reason: string }

export function buildArchivistPrompt(input: ArchivistInput): { system: string; user: string } {
  const tail = input.finalText.slice(-800)
  return {
    system:
      '你是小说流水线的档案管理员。任务：从章节末尾提取结束时的时空状态。只输出 JSON，不要任何解释。格式：{"endLocation":"地点","endDescription":"一句话场景","timeline":"时间推进描述"}。地点必须从给定列表中选择。',
    user: `已知地点档案：${input.locationNames.join('、')}\n\n章节末尾内容：\n${tail}`,
  }
}

export async function extractSpatiotemporalWithLlm(
  gateway: ModelGateway,
  input: ArchivistInput,
): Promise<ArchivistOutcome> {
  const prompt = buildArchivistPrompt(input)
  try {
    const response = await gateway.invoke('archivist', prompt, { projectId: input.projectId, chapter: input.chapter })
    const parsed = JSON.parse(extractJson(response.content)) as {
      endLocation?: string
      endDescription?: string
      timeline?: string
    }
    if (!parsed.endLocation || !input.locationNames.includes(parsed.endLocation)) {
      return { kind: 'pending-manual', reason: `提取地点不在档案列表：${String(parsed.endLocation)}` }
    }
    const endScene: SceneRef = {
      location: parsed.endLocation,
      description: parsed.endDescription ?? '',
    }
    return {
      kind: 'extracted',
      entry: {
        chapter: input.chapter,
        startScene: endScene,
        endScene,
        timeline: parsed.timeline ?? `第 ${input.chapter} 章内`,
        status: 'valid',
      },
    }
  } catch (err) {
    return { kind: 'pending-manual', reason: err instanceof Error ? err.message : String(err) }
  }
}

function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM 返回中不含 JSON')
  return text.slice(start, end + 1)
}