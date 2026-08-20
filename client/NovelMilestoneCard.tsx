import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelMilestoneEventData } from '../src/progress-feed.js'

interface PanelProps {
  readonly node: ChatNode<'novel-milestone'>
}

/** kind → 图标与配色（纯展示）：成功绿、隔离/降级橙、错误红，普通步骤灰。 */
const KIND_META: Record<NovelMilestoneEventData['kind'], { icon: string; color?: string }> = {
  step: { icon: '▸' },
  done: { icon: '✅', color: '#22c55e' },
  completed: { icon: '🎉', color: '#22c55e' },
  isolated: { icon: '⚠️', color: '#d97706' },
  fallback: { icon: '🔄', color: '#d97706' },
  error: { icon: '❌', color: '#dc2626' },
  status: { icon: 'ℹ️' },
}

/** 对话内小说步骤消息卡：一条独立流程步骤（章纲生成/章纲审查/正文写作/正文审查/终稿完成等）。
 *  每条自成一条聊天消息（无进度条汇总），右侧标注展示时间。 */
export function NovelMilestoneCard({ node }: PanelProps) {
  const d: NovelMilestoneEventData = node.data
  const meta = KIND_META[d.kind] ?? KIND_META.step
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 14px',
      margin: '2px 0',
      fontSize: 13,
      lineHeight: 1.6,
    }}>
      <span style={{ flexShrink: 0, ...(meta.color !== undefined ? { color: meta.color } : { opacity: 0.7 }) }}>{meta.icon}</span>
      <span style={{ color: meta.color }}>{d.text}</span>
      <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>{d.time}</span>
    </div>
  )
}
