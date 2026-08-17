import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AuthError,
  EmptyResponseError,
  NetworkError,
  TimeoutError,
  classifyHttpError,
} from '../errors.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  temperature?: number
  maxOutputTokens?: number
}

export interface ChatRequest {
  baseURL: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  params?: ChatParams
  timeoutMs?: number
  signal?: AbortSignal
  logFile?: string
}

export interface ChatResponse {
  content: string
  finishReason: string | null
  usage: { promptTokens: number; completionTokens: number } | null
  raw: unknown
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export const DEFAULT_TIMEOUT_MS = 300_000

export async function chatCompletion(req: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort(req.signal?.reason)
  if (req.signal) {
    if (req.signal.aborted) onExternalAbort()
    else req.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const body = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.params?.temperature,
    max_tokens: req.params?.maxOutputTokens,
    stream: false,
  })

  let response: Response
  try {
    response = await fetchImpl(`${req.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new TimeoutError()
    if (err instanceof Error && err.name === 'AbortError') throw new TimeoutError('请求被中止')
    throw new NetworkError(`网络错误：${(err as Error).message}`)
  } finally {
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onExternalAbort)
  }

  const text = await response.text()
  if (!response.ok) {
    const err = classifyHttpError(response.status, text)
    await persistRawSafe(req.logFile, requestSnapshot(req), text, response.status)
    throw err
  }

  await persistRawSafe(req.logFile, requestSnapshot(req), text, response.status)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new EmptyResponseError('响应不是合法 JSON')
  }
  const choice = (parsed as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> }).choices?.[0]
  const content = stripThink(choice?.message?.content)
  if (typeof content !== 'string' || content.trim() === '') {
    throw new EmptyResponseError()
  }
  const usage = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
  return {
    content,
    finishReason: choice?.finish_reason ?? null,
    usage: usage ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 } : null,
    raw: parsed,
  }
}

/**
 * 剥离推理模型内联输出中的思考段（如 MiniMax-M2 的 `<think>…</think>`）。
 * 完整块整体移除；未闭合的截断尾巴（流式中断场景）从标签起一并丢弃。
 */
export function stripThink(content: string | undefined): string | undefined {
  if (typeof content !== 'string') return content
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
}

interface RequestSnapshot {
  url: string
  model: string
  messages: ChatMessage[]
  params: ChatParams | undefined
}

function requestSnapshot(req: ChatRequest): RequestSnapshot {
  return {
    url: `${req.baseURL.replace(/\/$/, '')}/chat/completions`,
    model: req.model,
    messages: req.messages,
    params: req.params,
  }
}

async function persistRaw(logFile: string, request: RequestSnapshot, responseText: string, status: number): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    request,
    response: {
      status,
      body: responseText.length > 200_000 ? `${responseText.slice(0, 200_000)}...[truncated]` : responseText,
    },
  }
  try {
    await mkdir(dirname(logFile), { recursive: true })
    await writeFile(logFile, JSON.stringify(record, null, 2), 'utf-8')
  } catch {
    /* raw persistence must never break the pipeline */
  }
}

async function persistRawSafe(logFile: string | undefined, request: RequestSnapshot, responseText: string, status: number): Promise<void> {
  if (!logFile) return
  await persistRaw(logFile, request, responseText, status)
}

export function rawResponseFileName(role: string, chapter?: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `${ts}_${role}${chapter !== undefined ? `_ch${String(chapter).padStart(4, '0')}` : ''}.json`
}

export { AuthError }