import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const StyleAnchorSchema = z.object({
  anchorId: z.string().min(1),
  level: z.enum(['core', 'secondary']).default('core'),
  rule: z.string().min(1),
  violationExample: z.string().optional(),
})

export const StyleExemplarSchema = z.object({
  plain: z.string().min(1),
  styled: z.string().min(1),
  note: z.string().optional(),
})

/**
 * 风格包与去AI味全局层的边界协议（spec 术语表："去AI味管底线质量、风格包管风格方向，
 * 二者冲突时以此为界"）。风格包可声明阈值覆盖，仅放宽统计类密度/节奏阈值——
 * 开关与 severe 级语义不可覆盖（底线质量不因风格让渡）。
 */
export const QualityOverridesSchema = z.object({
  aiFlavorThresholds: z
    .object({
      maxColonDensityPerKChar: z.number().positive().optional(),
      maxDashDensityPerKChar: z.number().positive().optional(),
      minSentenceLengthCV: z.number().min(0).max(1).optional(),
      maxConjunctionDensityPerKChar: z.number().positive().optional(),
      maxParallelismRuns: z.number().int().positive().optional(),
      maxSimileDensityPerKChar: z.number().positive().optional(),
    })
    .default({}),
})

export const StylePackSchema = z.object({
  packId: z.string().min(1),
  displayName: z.string().min(1),
  environmentStrategy: z.string().default(''),
  anchors: z.array(StyleAnchorSchema).min(1),
  exemplars: z.array(StyleExemplarSchema).min(3),
  checklist: z.array(z.object({ anchorId: z.string().min(1), question: z.string().min(1) })).min(1),
  scopeNote: z.string().default(''),
  qualityOverrides: QualityOverridesSchema.default({}),
})

export type StylePack = z.infer<typeof StylePackSchema>
export type StyleAnchor = z.infer<typeof StyleAnchorSchema>

export class StylePackLoader {
  private readonly cache = new Map<string, StylePack>()

  constructor(private readonly packRootDir: string) {}

  async load(packId: string): Promise<StylePack> {
    const cached = this.cache.get(packId)
    if (cached) return cached
    const file = join(this.packRootDir, packId, 'pack.json')
    let text: string
    try {
      text = await readFile(file, 'utf-8')
    } catch {
      throw new StylePackError(`风格包不存在：${packId}`, packId)
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch {
      throw new StylePackError(`风格包文件损坏：${packId}`, packId)
    }
    const parsed = StylePackSchema.safeParse(parsedJson)
    if (!parsed.success) {
      throw new StylePackError(`风格包结构不合法：${packId}（${parsed.error.issues[0].message}）`, packId)
    }
    const pack = parsed.data
    const anchorIds = new Set(pack.anchors.map((a) => a.anchorId))
    if (pack.checklist.length !== pack.anchors.length || !pack.checklist.every((c) => anchorIds.has(c.anchorId))) {
      throw new StylePackError(`风格包检查清单必须与锚点一一对应：${packId}`, packId)
    }
    this.cache.set(packId, pack)
    return pack
  }

  async list(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    try {
      const entries = await readdir(this.packRootDir, { withFileTypes: true })
      const result: string[] = []
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const ok = await StylePackSchema.safeParseAsync(
          JSON.parse(await readFile(join(this.packRootDir, entry.name, 'pack.json'), 'utf-8').catch(() => 'null')),
        ).then((r) => r.success)
          .catch(() => false)
        if (ok) result.push(entry.name)
      }
      return result
    } catch {
      return []
    }
  }
}

export class StylePackError extends Error {
  readonly code = 'STYLE_PACK_INVALID'
  constructor(
    message: string,
    readonly packId: string,
  ) {
    super(message)
    this.name = 'StylePackError'
  }
}