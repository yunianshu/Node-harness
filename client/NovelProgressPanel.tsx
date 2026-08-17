import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelProgressEventData } from '../src/progress-feed.js'

interface PanelProps {
  readonly node: ChatNode<'novel-progress'>
}

/** 对话内小说进度卡片：进度条 + 计数 + 状态 + 隔离章 + 最近里程碑。 */
export function NovelProgressPanel({ node }: PanelProps) {
  const d: NovelProgressEventData = node.data
  const total = d.totalChapters
  const pct = total > 0 ? Math.round((d.finalDone / total) * 100) : 0
  const running = d.status === 'generating' || d.status === 'planning'
  return (
    <div style={{
      border: '1px solid rgba(125,125,125,0.35)',
      borderRadius: 8,
      padding: '10px 14px',
      margin: '6px 0',
      fontSize: 13,
      lineHeight: 1.7,
      background: 'rgba(125,125,125,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <span>{running ? '📖' : d.status === 'completed' ? '✅' : '⏸️'}</span>
        <span>{d.name}</span>
        <span style={{ fontWeight: 400, opacity: 0.75 }}>{statusLabel(d.status)}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 400 }}>{d.finalDone}/{total} 章 · {pct}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(125,125,125,0.25)', overflow: 'hidden', marginTop: 6 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: running ? '#3b82f6' : '#22c55e', transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, opacity: 0.85 }}>
        <span>章纲 {d.outlineDone}/{total}</span>
        <span>初稿 {d.draftDone}/{total}</span>
        <span>终稿 {d.finalDone}/{total}</span>
        {d.isolated.length > 0 && <span style={{ color: '#d97706' }}>隔离：第 {d.isolated.join(',')} 章</span>}
      </div>
      {d.note !== undefined && (
        <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>{d.note} · {d.updatedAt.slice(11, 19)}</div>
      )}
    </div>
  )
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return '待启动'
    case 'planning': return '规划中'
    case 'generating': return '生成中'
    case 'paused': return '已暂停'
    case 'completed': return '已完成'
    case 'aborted': return '已中止'
    default: return status
  }
}
