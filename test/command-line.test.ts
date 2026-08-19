import { describe, expect, it } from 'vitest'
import { coerceFlags, parseFlags } from '../src/command-line'
import type { CommandSpec } from '../src/app'

const planSpec: CommandSpec = {
  name: 'novel.plan',
  description: '执行规划阶段',
  args: [
    { key: 'project', required: true, description: '项目ID' },
    { key: 'model', required: false, description: '覆盖规划模型' },
    { key: 'temperature', required: false, description: '覆盖温度' },
    { key: 'maxTokens', required: false, description: '覆盖输出上限' },
  ],
}

const outlineSpec: CommandSpec = {
  name: 'novel.outline',
  description: '执行章纲阶段',
  args: [
    { key: 'project', required: true, description: '项目ID' },
    { key: 'chapters', required: false, description: '章号列表' },
    { key: 'model', required: false, description: '覆盖章纲模型' },
    { key: 'temperature', required: false, description: '覆盖温度' },
    { key: 'maxTokens', required: false, description: '覆盖输出上限' },
  ],
}

const startSpec: CommandSpec = {
  name: 'novel.start',
  description: '启动生成（逐阶段询问，--auto 全自动）',
  args: [
    { key: 'project', required: true, description: '项目ID' },
    { key: 'auto', required: false, description: '全自动不询问' },
  ],
}

describe('阶段命令 flag 解析', () => {
  it('novel.start --auto 解析为布尔 true（裸旗标）', () => {
    const args = coerceFlags(startSpec, parseFlags('--project p1 --auto'))
    expect(args.project).toBe('p1')
    expect(args.auto).toBe(true)
  })

  it('novel.outline --chapters 归一为数字列表（逗号分隔）', () => {
    const args = coerceFlags(outlineSpec, parseFlags('--project p1 --chapters 2,5,1'))
    expect(args.chapters).toEqual([2, 5, 1])
  })

  it('novel.plan --temperature/--maxTokens 作为字符串透传（app 层转数字）', () => {
    const args = coerceFlags(planSpec, parseFlags('--project p1 --temperature 0.4 --maxTokens 12000'))
    expect(args.temperature).toBe('0.4')
    expect(args.maxTokens).toBe('12000')
  })

  it('缺少 --project 报必填错误', () => {
    expect(() => coerceFlags(outlineSpec, parseFlags('--chapters 2'))).toThrow(/--project/)
  })

  it('未知参数仍被拒绝', () => {
    expect(() => coerceFlags(startSpec, parseFlags('--project p1 --bogus 1'))).toThrow(/--bogus/)
  })
})
