import { z } from 'zod'

export const CharacterTierSchema = z.enum(['主角', '重要配角', '次要配角', '路人'])
export type CharacterTier = z.infer<typeof CharacterTierSchema>

export const RelationEntrySchema = z.object({
  target: z.string().min(1),
  relation: z.string().min(1),
})
export type RelationEntry = z.infer<typeof RelationEntrySchema>

export const CharacterProfileSchema = z.object({
  name: z.string().min(1),
  tier: CharacterTierSchema,
  surfaceIdentity: z.string().optional(),
  trueCore: z.string().optional(),
  coreDesire: z.string().optional(),
  relations: z.array(RelationEntrySchema).default([]),
  narrativeFunction: z.string().optional(),
  firstAppearChapter: z.number().int().min(1).optional(),
})
export type CharacterProfile = z.infer<typeof CharacterProfileSchema>

export const LocationProfileSchema = z.object({
  name: z.string().min(1),
  spatialFeatures: z.string().default(''),
  moodTone: z.string().min(1),
  relatedCharacters: z.array(z.string()).default([]),
  narrativeFunction: z.string().optional(),
  firstAppearChapter: z.number().int().min(1).optional(),
})
export type LocationProfile = z.infer<typeof LocationProfileSchema>

export const WorldProfileSchema = z.object({
  worldview: z.string().min(1),
  themes: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
})
export type WorldProfile = z.infer<typeof WorldProfileSchema>

export const ScenePlanSchema = z.object({
  seq: z.number().int().min(1),
  locationRef: z.string().min(1),
  timeAdvance: z.string().min(1),
  purpose: z.string().min(1),
  transition: z.string().optional(),
})
export type ScenePlan = z.infer<typeof ScenePlanSchema>

export const ForeshadowPlanItemSchema = z.object({
  title: z.string().min(1),
  action: z.enum(['planted', 'revealed']),
  matrixRef: z.string().optional(),
})
export type ForeshadowPlanItem = z.infer<typeof ForeshadowPlanItemSchema>

export const RewriteTraceItemSchema = z.object({
  mode: z.enum(['first', 'directed', 'full-regen']),
  round: z.number().int().min(1),
  at: z.string(),
})
export type RewriteTraceItem = z.infer<typeof RewriteTraceItemSchema>

export const ChapterOutlineSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  keyEvents: z.array(z.string().min(1)).min(1),
  scenes: z.array(ScenePlanSchema).min(1),
  crossChapterHandoff: z.string().optional(),
  foreshadowPlan: z.array(ForeshadowPlanItemSchema).default([]),
  rewriteTrace: z.array(RewriteTraceItemSchema).default([]),
})
export type ChapterOutline = z.infer<typeof ChapterOutlineSchema>

export const ReviewIssueSchema = z.object({
  severity: z.enum(['severe', 'general', 'minor']),
  description: z.string().min(1),
  location: z.string().default(''),
})
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>

export const AiFlavorVerdictSchema = z.object({
  hardHits: z
    .array(
      z.object({
        type: z.string(),
        severity: z.string(),
        excerpt: z.string(),
      }),
    )
    .default([]),
  softFindings: z.array(z.string()).default([]),
})
export type AiFlavorVerdict = z.infer<typeof AiFlavorVerdictSchema>

export const ReviewReportSchema = z.object({
  target: z.object({
    kind: z.enum(['outline', 'draft']),
    chapter: z.number().int().min(1),
    version: z.number().int().min(1).default(1),
  }),
  score: z.number().min(0).max(10),
  issues: z.array(ReviewIssueSchema).default([]),
  styleDeviation: z.enum(['none', 'minor', 'severe']).default('none'),
  aiFlavorVerdict: AiFlavorVerdictSchema.default({ hardHits: [], softFindings: [] }),
  rewriteFeedback: z.string().optional(),
  reviewerModelMasked: z.string().default(''),
})
export type ReviewReport = z.infer<typeof ReviewReportSchema>

export interface PlanningArtifacts {
  world: WorldProfile
  characters: CharacterProfile[]
  locations: LocationProfile[]
}

export function validatePlanningArtifacts(
  artifacts: Partial<PlanningArtifacts>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const { world, characters = [], locations = [] } = artifacts

  if (!world || !world.worldview) problems.push('世界观档案缺失')
  if (characters.length === 0) problems.push('角色档案缺失')

  const byTier = (tier: CharacterTier) => characters.filter((c) => c.tier === tier)
  const protagonistCount = byTier('主角').length
  if (protagonistCount < 1 || protagonistCount > 3) problems.push(`主角数量必须为 1~3，当前 ${protagonistCount}`)

  for (const c of characters) {
    if (c.tier === '主角' || c.tier === '重要配角') {
      const full = c.surfaceIdentity && c.trueCore && c.coreDesire && c.relations.length > 0 && c.narrativeFunction
      if (!full) problems.push(`${c.tier}「${c.name}」档案字段不完整（需全量五字段）`)
    } else if (c.tier === '次要配角') {
      if (!c.surfaceIdentity || c.relations.length === 0) problems.push(`次要配角「${c.name}」需至少身份+主线关系`)
    } else if (c.tier === '路人') {
      if (!c.narrativeFunction) problems.push(`路人「${c.name}」需名字+功能`)
    }
  }

  for (const c of characters.filter((x) => x.tier === '主角' || x.tier === '重要配角')) {
    for (const rel of c.relations) {
      const target = characters.find((x) => x.name === rel.target)
      if (!target) continue // LLM 偶发把物件/地点写进关系（如「沈铁衣→黑棺」），指向不存在角色不阻断
      const back = target.relations.some((r) => r.target === c.name)
      if (!back) problems.push(`人物关系不双向闭合：「${c.name}」→「${rel.target}」缺反向关系`)
    }
  }

  for (const loc of locations) {
    if (!loc.moodTone) problems.push(`地点「${loc.name}」缺氛围基调`)
  }

  return { ok: problems.length === 0, problems }
}

export function validateOutlineStructure(
  outline: unknown,
  locationNames: string[],
  knownForeshadowTitles: string[],
): { ok: boolean; problems: string[]; value: ChapterOutline | null } {
  const problems: string[] = []
  const parsed = ChapterOutlineSchema.safeParse(outline)
  if (!parsed.success) {
    problems.push(`章纲结构不合法：${parsed.error.issues[0].path.join('.')} ${parsed.error.issues[0].message}`)
    return { ok: false, problems, value: null }
  }
  const o = parsed.data
  for (const scene of o.scenes) {
    const resolved = resolveLocationName(scene.locationRef, locationNames)
    if (resolved === null) {
      problems.push(`场景 ${scene.seq} 地点「${scene.locationRef}」未在地点档案中（可用：${locationNames.join('、')}）`)
    } else {
      scene.locationRef = resolved
    }
  }
  if (o.foreshadowPlan.length > 0 && knownForeshadowTitles.length > 0) {
    for (const plan of o.foreshadowPlan) {
      if (plan.matrixRef && !plan.title) problems.push('伏笔计划缺标题')
    }
  }
  return { ok: problems.length === 0, problems, value: o }
}

/** 剥离名称中的括号注释与空白，得到比对基名（「旧宅废墟（沈家老宅）」→「旧宅废墟」）。 */
function locationBaseName(name: string): string {
  return name.replace(/[（(][^（）()]*[)）]/g, '').replace(/\s+/g, '')
}

/**
 * 解析章纲地点引用到地点档案名：精确命中 → 括号注释归一命中（唯一时）→ 无法解析。
 * 模型间命名漂移（档案带注释、章纲省略注释）是常态，归一后回写规范名（spec 6.3 防的是悬空引用而非同义引用）。
 */
export function resolveLocationName(ref: string, knownNames: string[]): string | null {
  if (knownNames.includes(ref)) return ref
  const base = locationBaseName(ref)
  const candidates = knownNames.filter((name) => locationBaseName(name) === base)
  if (candidates.length === 1) return candidates[0]
  return null
}