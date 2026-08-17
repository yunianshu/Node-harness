import type { CharacterTierCN, SceneRef, SpacetimeEntry } from './matrix-store.js'

export interface ForeshadowPlanItem {
  title: string
  action: 'planted' | 'revealed'
}

export interface OutlineForExtraction {
  chapter: number
  foreshadowPlan?: ForeshadowPlanItem[]
}

export interface ExtractionInput {
  finalText: string
  outline: OutlineForExtraction
  characterTiers: Map<string, CharacterTierCN>
  locationNames: string[]
}

export interface ExtractionResult {
  foreshadowOps: ForeshadowPlanItem[]
  motifsHit: string[]
  characterAppearances: string[]
  protagonistUpdates: Array<{ name: string; note: string }>
  spacetime: SpacetimeEntry | null
}

const MOTIF_LEXICON = [
  '雪',
  '刀',
  '灯',
  '雨',
  '酒',
  '伞',
  '镜子',
  '信',
  '海棠',
  '残阳',
  '长街',
  '渡口',
]

const TIME_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /次日|第二日|第二天/, label: '次日' },
  { re: /当夜|是夜|入夜/, label: '当夜' },
  { re: /三[日天]后|三天之后/, label: '三天后' },
  { re: /黄昏|傍晚/, label: '黄昏' },
  { re: /清晨|天明|拂晓/, label: '清晨' },
  { re: /深秋|入冬|初雪/, label: '季节更替' },
  { re: /一月后|一个月后/, label: '一月后' },
]

function keywordsOf(title: string): string[] {
  const words = title.split(/[，。、\s：:；;（）()「」《》/]/).filter((w) => w.length >= 2)
  return words.length > 0 ? words : [title]
}

export function extractFromFinal(input: ExtractionInput): ExtractionResult {
  const { finalText, outline, characterTiers, locationNames } = input

  const foreshadowOps: ForeshadowPlanItem[] = []
  for (const plan of outline.foreshadowPlan ?? []) {
    const keywords = keywordsOf(plan.title)
    const coPresent = keywords.some((kw) => finalText.includes(kw))
    if (coPresent) foreshadowOps.push(plan)
  }

  const motifsHit = MOTIF_LEXICON.filter((m) => finalText.includes(m))

  const characterAppearances = [...characterTiers.keys()].filter((name) => finalText.includes(name))

  const protagonistUpdates = characterAppearances
    .filter((name) => characterTiers.get(name) === '主角')
    .map((name) => ({ name, note: `第 ${outline.chapter} 章出场，状态待更新` }))

  const spacetime = parseSpatiotemporalFromTail(finalText, outline.chapter, locationNames)

  return { foreshadowOps, motifsHit, characterAppearances, protagonistUpdates, spacetime }
}

export function parseSpatiotemporalFromTail(text: string, chapter: number, locationNames: string[]): SpacetimeEntry | null {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return null
  const tail = paragraphs.slice(-2).join(' ')
  const head = paragraphs.slice(0, 2).join(' ')

  const endLocation = findLocation(tail, locationNames)
  const startLocation = findLocation(head, locationNames)
  if (!endLocation) return null

  const timeline = findTimeMarker(tail) ?? findTimeMarker(head) ?? `第 ${chapter} 章内`

  const startScene: SceneRef = {
    location: startLocation ?? endLocation,
    description: head.slice(0, 40),
  }
  const endScene: SceneRef = {
    location: endLocation,
    description: tail.slice(0, 40),
  }
  return { chapter, startScene, endScene, timeline, status: 'valid' }
}

function findLocation(text: string, locationNames: string[]): string | null {
  let best: string | null = null
  for (const name of locationNames) {
    if (text.includes(name)) {
      if (best === null || name.length > best.length) best = name
    }
  }
  return best
}

function findTimeMarker(text: string): string | null {
  for (const marker of TIME_MARKERS) {
    if (marker.re.test(text)) return marker.label
  }
  return null
}