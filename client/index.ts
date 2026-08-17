/**
 * novel-harness 浏览器插件（dsh.client）：把 novel/progress 会话事件
 * 渲染为对话内实时进度卡片。经宿主 client-modules 扫描
 * exports["./client"] 装载，bundle 由 scripts/build-client.mjs 产出。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NovelProgressPanel } from './NovelProgressPanel.tsx'
import { novelProgressDefinition } from './definition.ts'

export const name = 'novel-harness-client'

/** conversationEvents/slots 由 client-runtime 与 ui-conversation 提供。 */
export const inject = ['conversationEvents', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.conversationEvents.register(novelProgressDefinition), 'novel-progress: definition')
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'novel-progress',
    priority: 5,
  }, NovelProgressPanel)), 'novel-progress: chat renderer')
}
