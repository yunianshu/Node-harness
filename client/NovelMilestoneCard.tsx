import { useState } from 'react'
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
 *  每条自成一条聊天消息（无进度条汇总），右侧标注展示时间；有推理数据时下方挂默认折叠的思考块。 */
export function NovelMilestoneCard({ node }: PanelProps) {
  const d: NovelMilestoneEventData = node.data
  const meta = KIND_META[d.kind] ?? KIND_META.step
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const hasReasoning = typeof d.reasoning === 'string' && d.reasoning.length > 0
  return (
    <div>
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
      {hasReasoning && (
        <div style={{
          borderRadius: 8,
          padding: '6px 14px',
          margin: '2px 14px 6px',
          fontSize: 13,
          lineHeight: 1.6,
          background: 'rgba(125,125,125,0.06)',
        }}>
          <button
            type="button"
            onClick={() => setReasoningOpen((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: 12,
              cursor: 'pointer',
              opacity: 0.7,
              color: 'inherit',
            }}
          >
            💭 {reasoningOpen ? '收起思考' : '思考（点击展开）'}
          </button>
          {reasoningOpen && (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 6 }}>
              {d.reasoning}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
