import type { CommandSpec } from './app.js'

/**
 * novel-* 命令的输入语法解析：dsh 命令体系只透传 rawInput 原文
 * （"Only unstructured text input"），语法由各命令自行定义（design 2.1.2 集成方式第 2 条）。
 * 约定：`--key value` / `--key=value` / 布尔裸旗标 `--flag`，值支持单双引号包裹。
 */

/** 解析结果：kebab-case 键归一为 camelCase，裸旗标解析为 true。 */
export type ParsedFlags = Record<string, string | boolean>

/** 切分 rawInput 为参数词元，支持单/双引号包裹含空白的值。 */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of input.trim()) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (quote !== null) throw new Error('引号未闭合')
  if (started) tokens.push(current)
  return tokens
}

function camelKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** 解析 --key value / --key=value / --flag 语法；遇到非 -- 开头词元报错。 */
export function parseFlags(input: string): ParsedFlags {
  const tokens = tokenize(input)
  const flags: ParsedFlags = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的参数："${token}"（仅支持 --key value 形式）`)
    }
    const body = token.slice(2)
    if (body.length === 0) throw new Error('空的参数名（"--"）')
    const eq = body.indexOf('=')
    if (eq >= 0) {
      const value = body.slice(eq + 1)
      if (value.length === 0) throw new Error(`--${body.slice(0, eq)} 缺少值`)
      flags[camelKey(body.slice(0, eq))] = value
      continue
    }
    const next = tokens[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[camelKey(body)] = next
      i++
    } else {
      flags[camelKey(body)] = true
    }
  }
  return flags
}

/** 校验必填参数并转换为 executeCommand 入参（列表/布尔归一）。 */
export function coerceFlags(spec: CommandSpec, flags: ParsedFlags): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const arg of spec.args) {
    const value = flags[arg.key]
    if (value === undefined) {
      if (arg.required) throw new Error(`缺少必填参数 --${arg.key}（${arg.description}）\n${usageOf(spec)}`)
      continue
    }
    if (isListKey(spec, arg.key) && value !== true) {
      args[arg.key] = String(value).split(',').map((n) => Number(n.trim()))
    } else if (isBoolKey(spec, arg.key)) {
      args[arg.key] = value === true || value === 'true' || value === '1'
    } else {
      args[arg.key] = value
    }
  }
  const known = new Set(spec.args.map((a) => a.key))
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw new Error(`未知参数 --${key}\n${usageOf(spec)}`)
  }
  return args
}

/** 列表型参数（章号列表）。 */
function isListKey(spec: CommandSpec, key: string): boolean {
  return key === 'chapters' && (spec.name === 'novel.regenerate' || spec.name === 'novel.guidance.regen')
}

/** 布尔型参数（裸旗标语义）。 */
function isBoolKey(spec: CommandSpec, key: string): boolean {
  return (spec.name === 'novel.export' && key === 'allowGaps') || (spec.name === 'novel.guidance.regen' && key === 'confirmFinal')
}

/** 由命令规格生成用法提示（必填裸露、可选加方括号）。 */
export function usageOf(spec: CommandSpec): string {
  const parts = spec.args.map((a) => (a.required ? `--${a.key} <${a.description}>` : `[--${a.key} <${a.description}>]`))
  return `${commandNameOf(spec.name)} ${parts.join(' ')}`
}

/** 点号命令名映射为 dsh 合法命令名（小写字母/数字/连字符）：novel.create → novel-create。 */
export function commandNameOf(dotName: string): string {
  return dotName.replace(/\./g, '-')
}
