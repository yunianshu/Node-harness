import type {
  ChatConversationViewNode,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelMilestoneEventData } from '../src/progress-feed.js'
import type { NovelToc } from '../src/notify/progress.js'

/** 里程碑消息卡状态：一条独立步骤消息（start 即完整载荷，无 update 折叠）。 */
export type NovelMilestoneState = NovelMilestoneEventData

/** 目录卡折叠态：项目名 + 最新一帧目录快照（latest-write-wins）。 */
export interface NovelTocState {
  readonly name: string
  readonly snapshot: NovelToc | null
}

/** 正文流式卡状态：按「projectId-chapter」键控，累积 delta 文本直至收束。 */
export interface NovelStoryState {
  readonly projectId: string
  readonly chapter: number
  readonly title?: string
  /** 已累积的正文（增量帧拼接）。 */
  readonly text: string
  /** 终稿评分（story-finish 带 score 时）。 */
  readonly score?: number
  /** 审查超限被隔离。 */
  readonly isolated: boolean
  /** 是否已收束（收到 story-finish）。 */
  readonly done: boolean
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 小说步骤消息的载荷（一条独立步骤）。 */
    'novel-milestone': NovelMilestoneEventData
    /** 小说正文流式卡片的载荷（累积文本）。 */
    'novel-story': NovelStoryState
    /** 小说目录卡片的载荷（最新快照）。 */
    'novel-toc': NovelToc
  }
}

/**
 * novel/milestone 会话事件 → 一条独立聊天消息（每条唯一 id，start 即完整载荷）。
 * 每个流程步骤（章纲生成/章纲审查/正文写作/正文审查/终稿完成等）各落一条，逐条排列。
 */
export const novelMilestoneDefinition: ConversationNodeDefinition<NovelMilestoneState> = {
  kind: 'novel-milestone',
  target: 'chat',
  match: (event) => {
    if (event.type === 'novel/milestone') {
      return { id: event.data.id, role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'novel/milestone') {
      throw new Error('novel-milestone start requires novel/milestone')
    }
    return match.event.data
  },
  update: (context) => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'novel-milestone',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}

/**
 * novel/toc 会话事件族 → 一张按 projectId 键控的对话目录卡片。
 * 起始帧（novel/toc-start）开卡，后续每帧快照整体替换（快照语义）。
 * 目录数据从落盘产物实时重建（产物即真相），客户端仅呈现。
 */
export const novelTocDefinition: ConversationNodeDefinition<NovelTocState> = {
  kind: 'novel-toc',
  target: 'chat',
  match: (event) => {
    if (event.type === 'novel/toc-start') {
      return { id: String(event.data.projectId), role: 'start' }
    }
    if (event.type === 'novel/toc') {
      return { id: String(event.data.projectId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'novel/toc-start') {
      throw new Error('novel-toc start requires novel/toc-start')
    }
    return { name: match.event.data.name, snapshot: null }
  },
  update: (context, match) => {
    if (match.event.type === 'novel/toc') {
      return { ...context.state, snapshot: match.event.data }
    }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state?.snapshot == null) return null
    return {
      key: context.key,
      kind: 'novel-toc',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state.snapshot,
    }
  },
}

/**
 * novel/story-* 会话事件族 → 一张按「projectId-chapter」键控的正文流式卡片。
 * start 开卡，delta 增量帧累积文本（animation-frame 节流发布），finish 收束并带终稿评分。
 */
export const novelStoryDefinition: ConversationNodeDefinition<NovelStoryState> = {
  kind: 'novel-story',
  target: 'chat',
  match: (event) => {
    if (event.type === 'novel/story-start') {
      return { id: `${event.data.projectId}-${event.data.chapter}`, role: 'start' }
    }
    if (
      event.type === 'novel/story-delta' ||
      event.type === 'novel/story-finish' ||
      event.type === 'novel/story-reset'
    ) {
      // resume 等场景 finish 可能在本次会话无 start：update 对未开卡 id 由引擎丢弃，无害
      return { id: `${event.data.projectId}-${event.data.chapter}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'novel/story-start') {
      throw new Error('novel-story start requires novel/story-start')
    }
    const d = match.event.data
    return { projectId: d.projectId, chapter: d.chapter, title: d.title, text: '', isolated: false, done: false }
  },
  update: (context, match) => {
    const e = match.event
    if (e.type === 'novel/story-reset') {
      // regen/重试重写同一章：清空既有正文与收束标记，后续 delta 以新稿重新累积
      return { ...context.state, text: '', done: false, score: undefined, isolated: false }
    }
    if (e.type === 'novel/story-delta') {
      return { ...context.state, text: context.state.text + e.data.delta }
    }
    if (e.type === 'novel/story-finish') {
      return { ...context.state, done: true, score: e.data.score, isolated: e.data.isolated === true }
    }
    return context.state
  },
  publication: (match) => {
    // 高频增量帧按渲染帧节流发布（复刻 assistant 流式节点的 cadence）
    if (match.event.type === 'novel/story-delta') return 'animation-frame'
    return 'immediate'
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'novel-story',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
