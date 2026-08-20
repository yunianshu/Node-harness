import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NovelProgressEventData } from '../src/progress-feed.js'

interface PanelProps {
  readonly node: ChatNode<'novel-progress'>
}

/** 章内五步流水线（与进度视图 currentStage 推导一致）。 */
const STEPS = ['章纲', '审查', '写作', '审稿', '终稿']

/** currentStage → 步序（0 基；未知阶段归 0）。 */
function stepIndexOf(stage: string): number {
  switch (stage) {
    case '章纲生成': return 0
    case '章纲审查': return 1
    case '正文写作': return 2
    case '正文审查': return 3
    case '已完成': return 4
    default: return stage === '规划' ? 0 : 0
  }
}

/** 对话内小说生成过程卡片：进度条 + 活跃章节环节步骤 + 最近过程时间线。 */
export function NovelProgressPanel({ node }: PanelProps) {
  const d: NovelProgressEventData = node.data
  const total = d.totalChapters
  const pct = total > 0 ? Math.round((d.finalDone / total) * 100) : 0
  const running = d.status === 'generating' || d.status === 'planning'
  const active = d.activeChapters ?? []
  const recent = d.recent ?? []
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

      {d.lastError !== undefined && d.lastError.length > 0 && (
        <div style={{
          marginTop: 6,
          padding: '4px 8px',
          borderRadius: 4,
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.4)',
          color: '#dc2626',
          fontSize: 12,
        }}>
          ⚠️ 失败：{d.lastError}
        </div>
      )}

      {active.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {active.map((c) => (
            <div key={c.chapter} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
              <span style={{ minWidth: 52, opacity: 0.85 }}>第 {c.chapter} 章</span>
              {STEPS.map((label, i) => (
                <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      display: 'inline-block',
                      background: i < stepIndexOf(c.stage) ? '#22c55e' : i === stepIndexOf(c.stage) ? '#3b82f6' : 'rgba(125,125,125,0.35)',
                      boxShadow: i === stepIndexOf(c.stage) && running ? '0 0 0 3px rgba(59,130,246,0.25)' : 'none',
                    }}
                  />
                  <span style={{ fontSize: 11, opacity: i === stepIndexOf(c.stage) ? 1 : 0.55 }}>{label}</span>
                </span>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.8 }}>{c.stage}</span>
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed rgba(125,125,125,0.35)' }}>
          {recent.map((r, i) => (
            <div key={`${r.time}-${i}`} style={{ display: 'flex', gap: 8, fontSize: 12, opacity: i === 0 ? 1 : 0.7 - i * 0.06 }}>
              <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{r.time}</span>
              <span>{r.note}</span>
            </div>
          ))}
        </div>
      )}

      {d.note !== undefined && (
        <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>{d.note}</div>
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
