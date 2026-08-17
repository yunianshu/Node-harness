import type { StylePack } from '../quality/style-pack-loader.js'
import type { MatrixInjection } from '../memory/injection-builder.js'
import type { ChapterOutline } from './schemas.js'

export const DE_AI_WRITING_RULES = [
  '每个场景必须有目标、有动作、有变化，禁止原地转圈。',
  '每段都要带来新东西——新事实、新动作、新后果；写过的不换说法重复。',
  '白话打底，在意词序和停顿；清除报告腔与模型腔。',
  '禁止翻案句：不许先给读者立一个他没有的误解再推翻（包括但不限于「不是……而是……」「你以为……其实……」「回头才发现」「看似……实则……」）。',
  '禁止 AI 黑话（如「在他看来」「仿佛在诉说着什么」「空气中弥漫着」「岁月的沉淀」）。',
  '冒号与破折号克制使用；长短句交错，保持节奏呼吸感。',
]

export const DE_AI_OUTLINE_RULES = [
  '章纲的每个场景必须有目标、有动作、有变化。',
  '场景计划禁止原地转圈：相邻场景必须带来新信息或新后果。',
  '摘要用白话，禁止翻案句式与报告腔。',
]

export interface PromptParts {
  system: string
  user: string
}

export interface OutlinePromptInput {
  mode: 'first' | 'directed' | 'full-regen'
  chapter: number
  totalChapters: number
  premiseDigest: string
  world: { worldview: string; themes: string[] }
  charactersDigest: string
  locationsDigest: string
  locationNames: string[]
  injection: MatrixInjection | null
  previousOutline: ChapterOutline | null
  reviewFeedback: string | null
  stylePack: StylePack
}

export class PromptBuilder {
  styleSection(pack: StylePack): string {
    const anchors = pack.anchors.map((a) => `- [${a.level}] ${a.rule}`).join('\n')
    const exemplars = pack.exemplars.map((e) => `- 平淡：${e.plain}\n  风格化：${e.styled}`).join('\n')
    return `【风格包：${pack.displayName}】\n风格锚点（不可偏离）：\n${anchors}\n正反示范：\n${exemplars}\n环境策略：${pack.environmentStrategy}`
  }

  deAiSection(kind: 'outline' | 'content'): string {
    const rules = kind === 'outline' ? DE_AI_OUTLINE_RULES : DE_AI_WRITING_RULES
    return `【中文质量底线（去AI味，全局叠加）】\n${rules.map((r) => `- ${r}`).join('\n')}`
  }

  injectionSection(injection: MatrixInjection | null): string {
    if (!injection) return ''
    const parts: string[] = []
    if (injection.foreshadows.length > 0) {
      const boosted = injection.foreshadows.filter((f) => f.priority === 'overdue-boosted')
      const normal = injection.foreshadows.filter((f) => f.priority === 'normal')
      if (normal.length > 0) parts.push(`待呼应伏笔：${normal.map((f) => `${f.id}「${f.title}」(${f.plantedChapter}章埋设)`).join('；')}`)
      if (boosted.length > 0) parts.push(`【必须处理】超期伏笔：${boosted.map((f) => `${f.id}「${f.title}」`).join('；')}（本章章纲必须安排揭示）`)
    }
    if (injection.motifRequirements.length > 0) parts.push(`意象复现要求：${injection.motifRequirements.join('、')}`)
    if (injection.mysteries.length > 0) parts.push(`待推进悬念：${injection.mysteries.map((m) => `${m.id}「${m.title}」`).join('；')}`)
    if (injection.themes.length > 0) parts.push(`主题回归：${injection.themes.join('、')}`)
    const protagonist = injection.characterStates.filter((c) => c.tier === '主角')
    if (protagonist.length > 0) {
      parts.push(`主角最新状态：${protagonist.map((c) => `${c.name}（${JSON.stringify(c.status)}）`).join('；')}`)
    }
    const sp = injection.spatiotemporal
    if (sp.latest) {
      parts.push(`上一章末时空状态：场景在「${sp.latest.endScene.location}」，时间：${sp.latest.timeline}。本章场景计划必须以此为起点衔接。`)
    }
    return parts.length > 0 ? `【跨章记忆矩阵注入】\n${parts.join('\n')}` : ''
  }

  buildOutlinePrompt(input: OutlinePromptInput): PromptParts {
    const sections: string[] = []
    sections.push(`你是一部长篇小说的章纲师。现写第 ${input.chapter}/${input.totalChapters} 章的章纲。`)
    sections.push(`【故事前提摘要】\n${input.premiseDigest}`)
    sections.push(`【世界观】\n${input.world.worldview}\n主题：${input.world.themes.join('、')}`)
    sections.push(`【角色档案】\n${input.charactersDigest}`)
    sections.push(`【地点档案】\n${input.locationsDigest}`)
    sections.push(`【可用地点】场景 locationRef 只能逐字取自以下名称（含括号注释时须完整照抄）：${input.locationNames.join('、')}`)
    const injection = this.injectionSection(input.injection)
    if (injection) sections.push(injection)
    sections.push(this.styleSection(input.stylePack))
    sections.push(this.deAiSection('outline'))
    if (input.mode === 'directed' && input.previousOutline && input.reviewFeedback) {
      sections.push(
        `【定向修改】以下是原章纲与审查反馈，仅修改问题处，保留合格部分：\n原章纲：${JSON.stringify(input.previousOutline, null, 1)}\n审查反馈：${input.reviewFeedback}`,
      )
    } else if (input.mode === 'full-regen') {
      sections.push(`【全量重生成】原章纲未通过审查，丢弃原稿重新生成整份章纲。历史审查反馈供参考：${input.reviewFeedback ?? '（无）'}`)
    }
    sections.push(
      '【输出要求】输出 JSON：{"chapter":章号,"title":"章节标题","summary":"摘要","keyEvents":["关键事件"],"scenes":[{"seq":序号,"locationRef":"地点档案名（逐字照抄【可用地点】之一）","timeAdvance":"时间推进","purpose":"场景功能","transition":"切换方式(可选)"}],"crossChapterHandoff":"跨章衔接说明(章末场景跳转时必填)","foreshadowPlan":[{"title":"伏笔标题","action":"planted|revealed"}]}。需要新地点时改用最接近的既有地点承载场景，不得虚构。',
    )
    return { system: sections.join('\n\n'), user: `生成第 ${input.chapter} 章章纲。` }
  }

  buildWriterPrompt(input: {
    chapter: number
    outline: ChapterOutline
    world: { worldview: string }
    charactersDigest: string
    injection: MatrixInjection | null
    previousChapterEnding: string | null
    mode: 'first' | 'directed'
    reviewFeedback: string | null
    aiFlavorHits: string[]
    guidanceNote: string | null
    stylePack: StylePack
    wordRange: { min: number; max: number }
  }): PromptParts {
    const sections: string[] = []
    sections.push(`你是一位小说作者。依据章纲写第 ${input.chapter} 章正文。`)
    sections.push(`【世界观】\n${input.world.worldview}`)
    sections.push(`【角色档案】\n${input.charactersDigest}`)
    const injection = this.injectionSection(input.injection)
    if (injection) sections.push(injection)
    if (input.previousChapterEnding) sections.push(`【上一章结尾】\n……${input.previousChapterEnding}`)
    sections.push(`【本章章纲】\n${JSON.stringify(input.outline, null, 1)}`)
    sections.push(this.styleSection(input.stylePack))
    sections.push(this.deAiSection('content'))
    if (input.mode === 'directed') {
      const feedbackParts: string[] = []
      if (input.reviewFeedback) feedbackParts.push(`审查反馈：${input.reviewFeedback}`)
      if (input.aiFlavorHits.length > 0) feedbackParts.push(`AI味命中清单：\n${input.aiFlavorHits.map((h) => `- ${h}`).join('\n')}`)
      if (input.guidanceNote) feedbackParts.push(`【创作者指导意见（最高优先级）】\n${input.guidanceNote}`)
      sections.push(`【定向重写】在保留合格内容的基础上修改以下问题：\n${feedbackParts.join('\n')}`)
    } else if (input.guidanceNote) {
      sections.push(`【创作者指导意见（最高优先级）】\n${input.guidanceNote}`)
    }
    sections.push(`【输出要求】只输出正文文本（不要标题不要解释），字数 ${input.wordRange.min}~${input.wordRange.max} 字，分段不少于 15 段。`)
    return { system: sections.join('\n\n'), user: `写第 ${input.chapter} 章正文。` }
  }

  buildReviewPrompt(input: {
    kind: 'outline' | 'draft'
    chapter: number
    content: string
    stylePack: StylePack
    gate: number
    consistencySignalsDigest: string | null
    previousSpacetimeDigest: string | null
  }): PromptParts {
    const sections: string[] = []
    sections.push(
      input.kind === 'outline'
        ? `你是章纲审查官。审查第 ${input.chapter} 章章纲。`
        : `你是正文审查官。审查第 ${input.chapter} 章正文初稿。`,
    )
    sections.push(`【风格锚点与检查清单】\n${input.stylePack.anchors.map((a) => `- ${a.rule}（检查：${input.stylePack.checklist.find((c) => c.anchorId === a.anchorId)?.question ?? ''}）`).join('\n')}`)
    sections.push(this.deAiSection(input.kind === 'outline' ? 'outline' : 'content'))
    if (input.consistencySignalsDigest) sections.push(`【一致性信号】\n${input.consistencySignalsDigest}`)
    if (input.previousSpacetimeDigest) sections.push(`【上一章末时空状态】\n${input.previousSpacetimeDigest}`)
    sections.push(`【待审内容】\n${input.content}`)
    sections.push(
      `【输出要求】输出 JSON：{"score":0到10分(一位小数),"issues":[{"severity":"severe|general|minor","description":"问题","location":"位置"}],"styleDeviation":"none|minor|severe","aiFlavorVerdict":{"softFindings":["软检查发现（原地转圈/车轱辘话/节奏单一）"]},"rewriteFeedback":"重写反馈要点"}。评分低于 ${input.gate} 触发重写；风格锚点严重偏离（styleDeviation=severe）直接不通过。不要猜测内容由哪个模型生成。`,
    )
    return { system: sections.join('\n\n'), user: input.kind === 'outline' ? `审查第 ${input.chapter} 章章纲。` : `审查第 ${input.chapter} 章正文。` }
  }
}