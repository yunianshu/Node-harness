import { z } from 'zod'

export const PipelineRoleSchema = z.enum([
  'planner',
  'outliner',
  'outline-reviewer',
  'writer',
  'reviewer',
  'archivist',
])
export type PipelineRole = z.infer<typeof PipelineRoleSchema>

export const AccessModeSchema = z.enum(['pay-as-you-go', 'glm-plan-cn', 'glm-plan-intl'])
export type AccessMode = z.infer<typeof AccessModeSchema>

export const ModelEndpointRefSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  accessMode: AccessModeSchema.default('pay-as-you-go'),
})
export type ModelEndpointRef = z.infer<typeof ModelEndpointRefSchema>

export const ModelBindingSchema = z.object({
  role: PipelineRoleSchema,
  primary: ModelEndpointRefSchema,
  fallbacks: z.array(ModelEndpointRefSchema).default([]),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive().default(8192),
  fallbackThreshold: z.number().int().positive().default(5),
})
export type ModelBinding = z.infer<typeof ModelBindingSchema>

export const QualityGatesSchema = z.object({
  outlineGate: z.number().min(0).max(10).default(8.0),
  draftGate: z.number().min(0).max(10).default(7.0),
  draftRewriteLimit: z.number().int().min(1).default(3),
  outlineDirectedLimit: z.number().int().min(1).default(2),
  outlineFullRegenLimit: z.number().int().min(0).default(1),
})
export type QualityGates = z.infer<typeof QualityGatesSchema>

export const StructuredQualitySchema = z.object({
  minWords: z.number().int().positive().default(2000),
  maxWords: z.number().int().positive().default(3000),
  hardFloorWords: z.number().int().positive().default(1500),
  minParagraphs: z.number().int().positive().default(15),
  maxDuplicateParagraphRatio: z.number().min(0).max(1).default(0.25),
  maxSimilarParagraphRatio: z.number().min(0).max(1).default(0.2),
  similarThreshold: z.number().min(0).max(1).default(0.88),
})
export type StructuredQuality = z.infer<typeof StructuredQualitySchema>

export const AiFlavorChecksSchema = z.object({
  reversalSentence: z.boolean().default(true),
  jargon: z.boolean().default(true),
  punctuation: z.boolean().default(true),
  sentenceRhythm: z.boolean().default(true),
  paragraphRhythm: z.boolean().default(true),
  conjunction: z.boolean().default(true),
  parallelism: z.boolean().default(true),
  lyricMetaphor: z.boolean().default(true),
  foreignText: z.boolean().default(true),
})

export const AiFlavorThresholdsSchema = z.object({
  maxColonDensityPerKChar: z.number().positive().default(3),
  maxDashDensityPerKChar: z.number().positive().default(3),
  /** 句长变异系数软下限（burstiness 反馈线，低于此值进入重写反馈）。 */
  minSentenceLengthCV: z.number().min(0).max(2).default(0.45),
  /** 句长变异系数硬下限（分布塌平判 severe 阻断）。 */
  minSentenceLengthCVHard: z.number().min(0).max(2).default(0.3),
  /** 段落长度变异系数软下限（段落节奏反馈线）。 */
  minParagraphLengthCV: z.number().min(0).max(3).default(0.55),
  /** 段落长度变异系数硬下限（段落节奏塌平判 severe）。 */
  minParagraphLengthCVHard: z.number().min(0).max(3).default(0.3),
  maxConjunctionDensityPerKChar: z.number().positive().default(8),
  maxParallelismRuns: z.number().int().positive().default(2),
  maxSimileDensityPerKChar: z.number().positive().default(4),
})

export const AiFlavorConfigSchema = z.object({
  checks: AiFlavorChecksSchema.default({}),
  thresholds: AiFlavorThresholdsSchema.default({}),
})
export type AiFlavorConfig = z.infer<typeof AiFlavorConfigSchema>
export type AiFlavorChecks = z.infer<typeof AiFlavorChecksSchema>
export type AiFlavorThresholds = z.infer<typeof AiFlavorThresholdsSchema>

export const SchedulingSchema = z.object({
  outlineLookahead: z.number().int().min(1).default(5),
  writerConcurrency: z.number().int().min(1).default(2),
  reviewerConcurrency: z.number().int().min(1).default(2),
  chapterFailureLimit: z.number().int().min(1).default(5),
})
export type Scheduling = z.infer<typeof SchedulingSchema>

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  initialDelayMs: z.number().int().min(0).default(5000),
})
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

export const ProjectStatusSchema = z.enum([
  'pending',
  'planning',
  'generating',
  'paused',
  'completed',
  'aborted',
])
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>

export const ProjectConfigSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(50),
  totalChapters: z.number().int().min(1).max(500),
  stylePackId: z.string().min(1),
  premiseSha256: z.string().length(64),
  premiseLength: z.number().int().positive(),
  gates: QualityGatesSchema.default({}),
  structured: StructuredQualitySchema.default({}),
  aiFlavor: AiFlavorConfigSchema.default({}),
  scheduling: SchedulingSchema.default({}),
  retry: RetryPolicySchema.default({}),
  bindings: z.array(ModelBindingSchema).default([]),
  status: ProjectStatusSchema.default('pending'),
  webhookUrl: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export const ProjectCreateInputSchema = z.object({
  name: z.string().min(1, '项目名称不能为空').max(50),
  premise: z.string().min(1, '故事前提不能为空'),
  totalChapters: z
    .number({ invalid_type_error: '总章数必须为整数' })
    .int('总章数必须为整数')
    .min(1, '总章数必须在 1~500 之间')
    .max(500, '总章数必须在 1~500 之间'),
  stylePackId: z.string().min(1).optional(),
  gates: QualityGatesSchema.partial().optional(),
  structured: StructuredQualitySchema.partial().optional(),
  aiFlavor: AiFlavorConfigSchema.partial().optional(),
  scheduling: SchedulingSchema.partial().optional(),
  retry: RetryPolicySchema.partial().optional(),
  bindings: z.array(ModelBindingSchema).optional(),
  webhookUrl: z.string().optional(),
})
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>

export const DEFAULT_STYLE_PACK = 'generic'
export const PREMISE_WARN_MIN_LENGTH = 50