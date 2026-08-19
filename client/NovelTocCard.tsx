import { useState } from 'react'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelToc } from '../src/notify/progress.js'

interface PanelProps {
  readonly node: ChatNode<'novel-toc'>
}

/** 对话内小说目录卡：折叠摘要（书名+进度统计+隔离章）+ 点击展开完整章节列表。
 *  目录数据从落盘产物实时重建（产物即真相），客户端仅呈现快照；useState 只做本地展开态。 */
export function NovelTocCard({ node }: PanelProps) {
  const d: NovelToc = node.data
  const [expanded, setExpanded] = useState(false)
  const total = d.totalChapters
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
        <span style={{ marginLeft: 'auto', fontWeight: 400 }}>终稿 {d.finalDone}/{total} 章</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6, opacity: 0.85 }}>
        <span>章纲 {d.outlineDone}/{total}</span>
        {d.isolated.length > 0 && <span style={{ color: '#d97706' }}>隔离：第 {d.isolated.join(',')} 章</span>}
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            marginLeft: 'auto',
            background: 'rgba(125,125,125,0.12)',
            border: '1px solid rgba(125,125,125,0.3)',
            borderRadius: 6,
            padding: '2px 10px',
            fontSize: 12,
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          {expanded ? '收起目录 ▴' : '展开目录 ▾'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed rgba(125,125,125,0.35)' }}>
          {d.entries.map((e) => (
            <div key={e.chapter} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <span style={{ minWidth: 52, opacity: 0.85 }}>第 {e.chapter} 章</span>
              <span style={{ fontWeight: e.title !== null ? 500 : 400, opacity: e.title !== null ? 1 : 0.55 }}>
                {e.title !== null ? `「${e.title}」` : '（章纲未产出）'}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.8 }}>{e.stage}</span>
              {typeof e.score === 'number' && <span style={{ fontSize: 12, opacity: 0.8 }}>评分 {e.score}</span>}
              {e.isolated && <span style={{ color: '#d97706', fontSize: 12 }}>⚠️已隔离</span>}
              {typeof e.wordCount === 'number' && <span style={{ fontSize: 12, opacity: 0.6 }}>{e.wordCount} 字</span>}
            </div>
          ))}
        </div>
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
