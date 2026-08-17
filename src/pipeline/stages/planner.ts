import { Stage, StageContext } from './stage.js'
import {
  CharacterProfile,
  LocationProfile,
  PlanningArtifacts,
  WorldProfile,
  validatePlanningArtifacts,
} from '../schemas.js'
import { extractJsonLoose } from './json-utils.js'

export interface PlannerInput {
  premise: string
  repairFeedback: string[]
  stylePackName: string
}

export class PlannerStage extends Stage<PlannerInput, PlanningArtifacts> {
  constructor() {
    super('planner')
  }

  protected async run(input: PlannerInput, ctx: StageContext): Promise<PlanningArtifacts> {
    const prompt = this.buildPrompt(input)
    const response = await ctx.gateway.invoke('planner', prompt, { projectId: ctx.projectId })
    const parsed = extractJsonLoose(response.content) as Record<string, unknown>
    const artifacts = this.coerce(parsed)
    const validation = validatePlanningArtifacts(artifacts)
    if (!validation.ok) {
      throw new PlannerIncompleteError(validation.problems)
    }
    return artifacts as PlanningArtifacts
  }

  buildPrompt(input: PlannerInput): { system: string; user: string } {
    const repair =
      input.repairFeedback.length > 0
        ? `\n\n【上次产物校验未通过，必须补全】\n${input.repairFeedback.map((p) => `- ${p}`).join('\n')}`
        : ''
    return {
      system: `你是一部${input.stylePackName}风格长篇小说的规划师。基于故事前提产出三份档案。${repair}`,
      user: `故事前提：\n${input.premise}\n\n输出 JSON：{"world":{"worldview":"世界观","themes":["主题"]},"characters":[{"name":"名字","tier":"主角|重要配角|次要配角|路人","surfaceIdentity":"表面身份","trueCore":"真实内核","coreDesire":"核心欲望","relations":[{"target":"对方名字","relation":"关系"}],"narrativeFunction":"叙事功能"}],"locations":[{"name":"地点名","spatialFeatures":"空间特征","moodTone":"氛围基调","relatedCharacters":["关联角色"],"narrativeFunction":"叙事功能"}]}\n要求：主角 1~3 人；主角与重要配角全字段；次要配角至少身份+主线关系；路人至少功能；人物关系双向闭合；地点覆盖前提中全部主要场景且必含氛围基调。`,
    }
  }

  private coerce(parsed: unknown): Partial<PlanningArtifacts> {
    if (typeof parsed !== 'object' || parsed === null) return {}
    const obj = parsed as Record<string, unknown>
    const world = (obj.world ?? {}) as Record<string, unknown>
    const characters = Array.isArray(obj.characters) ? (obj.characters as CharacterProfile[]) : []
    const locations = Array.isArray(obj.locations) ? (obj.locations as LocationProfile[]) : []
    return {
      world: world.worldview ? ({ worldview: String(world.worldview), themes: (world.themes as string[]) ?? [], rules: [] } as WorldProfile) : undefined,
      characters,
      locations,
    }
  }
}

export class PlannerIncompleteError extends Error {
  readonly code = 'PLANNER_INCOMPLETE'
  constructor(readonly problems: string[]) {
    super(`规划产物不完整：${problems.join('；')}`)
    this.name = 'PlannerIncompleteError'
  }
}