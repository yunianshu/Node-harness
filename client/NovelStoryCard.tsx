import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelStoryState } from './definition.ts'

interface PanelProps {
  readonly node: ChatNode<'novel-story'>
}

/** 正文流式消息卡：标题栏 + 累积正文（pre-wrap 随 delta 逐帧刷新）+ 收束标记。
 *  外观贴近 assistant 文本消息，流式中显示闪烁光标，完成/隔离显示收束注脚。 */
export function NovelStoryCard({ node }: PanelProps) {
  const s: NovelStoryState = node.data
  return (
    <div style={{
      borderRadius: 8,
      padding: '8px 14px',
      margin: '6px 0',
      fontSize: 14,
      lineHeight: 1.8,
      background: 'rgba(125,125,125,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, opacity: 0.9 }}>
        <span>✍️</span>
        <span>第 {s.chapter} 章{typeof s.title === 'string' && s.title.length > 0 ? `「${s.title}」` : ''}正文</span>
        {!s.done && <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.6 }}>生成中…</span>}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>
        {s.text.length > 0 ? s.text : <span style={{ opacity: 0.5 }}>（正文生成中）</span>}
        {!s.done && s.text.length > 0 && (
          <>
            <style>{'@keyframes novel-caret-blink { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }'}</style>
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: '1em',
                background: '#3b82f6',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'novel-caret-blink 1s step-end infinite',
              }}
            />
          </>
        )}
      </div>
      {s.done && (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75, borderTop: '1px dashed rgba(125,125,125,0.35)', paddingTop: 4 }}>
          {s.isolated ? (
            <span style={{ color: '#d97706' }}>⚠️ 本章正文审查超限，已隔离（可 manual 重生成）</span>
          ) : (
            <span>✅ 终稿完成{typeof s.score === 'number' ? ` · 评分 ${s.score}` : ''}</span>
          )}
        </div>
      )}
    </div>
  )
}
