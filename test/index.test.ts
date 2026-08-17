import { describe, expect, it } from 'vitest'
import { apply, FakeHost } from '../src/index'
import type { HostProvider } from '../src/host/types'

interface Disposable {
  handlers: Array<() => void>
  on(event: 'dispose', fn: () => void): unknown
  novelHost?: HostProvider
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
  it('applies host to context and cleans up on dispose (FakeHost default)', () => {
    const ctx = makeCtx()
    apply(ctx as never)
    expect(ctx.novelHost).toBeInstanceOf(FakeHost)
    for (const fn of ctx.handlers) fn()
    expect(ctx.novelHost).toBeUndefined()
  })

  it('uses provided host instance without creating another', () => {
    const ctx = makeCtx()
    const host = new FakeHost()
    apply(ctx as never, { host })
    expect(ctx.novelHost).toBe(host)
  })
})