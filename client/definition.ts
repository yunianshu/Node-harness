import type {
  ChatConversationViewNode,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelProgressEventData } from '../src/progress-feed.js'

/** 折叠态：项目名 + 最新一帧进度快照（latest-write-wins）。 */
export interface NovelProgressState {
  readonly name: string
  readonly snapshot: NovelProgressEventData | null
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 小说生成进度卡片的载荷（最新快照）。 */
    'novel-progress': NovelProgressEventData
  }
}

/**
 * novel/progress 会话事件族 → 一张按 projectId 键控的对话进度卡片。
 * 起始帧（novel/progress-start）开卡，后续每帧快照整体替换（快照语义）。
 */
export const novelProgressDefinition: ConversationNodeDefinition<NovelProgressState> = {
  kind: 'novel-progress',
  target: 'chat',
  match: (event) => {
    if (event.type === 'novel/progress-start') {
      return { id: String(event.data.projectId), role: 'start' }
    }
    if (event.type === 'novel/progress') {
      return { id: String(event.data.projectId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'novel/progress-start') {
      throw new Error('novel-progress start requires novel/progress-start')
    }
    return { name: match.event.data.name, snapshot: null }
  },
  update: (context, match) => {
    if (match.event.type === 'novel/progress') {
      return { ...context.state, snapshot: match.event.data }
    }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state?.snapshot == null) return null
    return {
      key: context.key,
      kind: 'novel-progress',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state.snapshot,
    }
  },
}
