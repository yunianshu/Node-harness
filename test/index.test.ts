import { describe, expect, it } from 'vitest'
import { apply, FakeHost, NovelHarnessApp } from '../src/index'
import type { NovelHarnessApp as App } from '../src/app'

interface Disposable {
  handlers: Array<() => void>
  on(event: 'dispose', fn: () => void): unknown
  novelApp?: App
  novelHost?: unknown
}

function makeCtx(): Disposable {
  const ctx: Disposable = { handlers: [] }
  ctx.on = (_event, fn) => {
    ctx.handlers.push(fn)
    return () => {}
  }
  return ctx
}

describe('plugin entry', () => {
  it('applies app to context and cleans up on dispose (FakeHost default)', () => {
    const ctx = makeCtx()
    apply(ctx as never)
    expect(ctx.novelApp).toBeInstanceOf(NovelHarnessApp)
    for (const fn of ctx.handlers) fn()
    expect(ctx.novelApp).toBeUndefined()
  })

  it('uses provided host instance without creating another', () => {
    const ctx = makeCtx()
    const host = new FakeHost()
    apply(ctx as never, { host })
    expect(ctx.novelApp?.host).toBe(host)
  })

  it('exposes full command list through app', () => {
    const ctx = makeCtx()
    apply(ctx as never)
    const commands = ctx.novelApp!.commands().map((c) => c.name)
    expect(commands).toContain('novel.create')
    expect(commands).toContain('novel.guidance.regen')
  })
})
