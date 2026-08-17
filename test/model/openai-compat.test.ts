import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatMessage, chatCompletion } from '../../src/model/providers/openai-compat'
import { AuthError, EmptyResponseError, RetryableServerError, TimeoutError } from '../../src/model/errors'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const okBody = {
  choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}

describe('openai-compat adapter', () => {
  it('returns parsed content on success', async () => {
    const res = await chatCompletion(
      { baseURL: 'http://mock/v1', apiKey: 'sk-test', model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      async () => jsonResponse(200, okBody),
    )
    expect(res.content).toBe('hello world')
    expect(res.usage?.completionTokens).toBe(5)
  })

  it('maps 401 to AuthError', async () => {
    await expect(
      chatCompletion(
        { baseURL: 'http://mock/v1', apiKey: 'bad', model: 'm1', messages: [] },
        async () => jsonResponse(401, { error: 'unauthorized' }),
      ),
    ).rejects.toBeInstanceOf(AuthError)
  })

  it('maps timeout to TimeoutError', async () => {
    await expect(
      chatCompletion(
        {
          baseURL: 'http://mock/v1',
          apiKey: 'sk',
          model: 'm',
          messages: [],
          timeoutMs: 20,
        },
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(jsonResponse(200, okBody)), 100)
            init.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError'))
            })
          }),
      ),
    ).rejects.toBeInstanceOf(TimeoutError)
  })

  it('maps empty content to EmptyResponseError', async () => {
    await expect(
      chatCompletion(
        { baseURL: 'http://mock/v1', apiKey: 'sk', model: 'm', messages: [] },
        async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }),
      ),
    ).rejects.toBeInstanceOf(EmptyResponseError)
  })

  it('maps 500 to RetryableServerError', async () => {
    await expect(
      chatCompletion(
        { baseURL: 'http://mock/v1', apiKey: 'sk', model: 'm', messages: [] },
        async () => jsonResponse(500, 'boom'),
      ),
    ).rejects.toBeInstanceOf(RetryableServerError)
  })

  it('persists raw request/response without api key (spec 4.4.1 / 4.3.1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raw-'))
    const logFile = join(dir, 'sub', '2026-01-01_writer_ch0001.json')
    await chatCompletion(
      { baseURL: 'http://mock/v1', apiKey: 'sk-secret-abcdef', model: 'm', messages: [{ role: 'user', content: 'hi' }], logFile },
      async () => jsonResponse(200, okBody),
    )
    const files = await readdir(join(dir, 'sub'))
    expect(files).toHaveLength(1)
    const persisted = await readFile(logFile, 'utf-8')
    expect(persisted).not.toContain('sk-secret-abcdef')
    expect(persisted).toContain('hello world')
  })

  it('system prompt becomes first message with role=system', async () => {
    let seen: ChatMessage[] = []
    await chatCompletion(
      { baseURL: 'http://mock/v1', apiKey: 'sk', model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }] },
      async (_url, init) => {
        seen = JSON.parse(String(init.body)).messages
        return jsonResponse(200, okBody)
      },
    )
    expect(seen.map((m) => m.role)).toEqual(['system', 'user'])
  })
})