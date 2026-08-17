import { describe, expect, it } from 'vitest'
import { ChapterSlotManager } from '../../src/pipeline/worker-pool'
import { IsolationLedger } from '../../src/pipeline/isolation'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('chapter slot manager', () => {
  it('two chapters run in parallel while same chapter is serialized (spec 5.3.1 rule 6)', async () => {
    const pool = new ChapterSlotManager(2)
    const events: string[] = []
    const task = async (name: string, ms: number) => {
      events.push(`start:${name}`)
      await new Promise((r) => setTimeout(r, ms))
      events.push(`end:${name}`)
    }
    const ch3Write = pool.runExclusive(3, 'normal', () => task('ch3-write', 30))
    const ch3Review = pool.runExclusive(3, 'normal', () => task('ch3-review', 5))
    const ch4Write = pool.runExclusive(4, 'normal', () => task('ch4-write', 10))
    await Promise.all([ch3Write, ch3Review, ch4Write])
    expect(events.indexOf('start:ch3-review')).toBeGreaterThan(events.indexOf('end:ch3-write'))
    expect(events.indexOf('start:ch4-write')).toBeLessThan(events.indexOf('end:ch3-write'))
  })

  it('guidance priority jumps the queue', async () => {
    const pool = new ChapterSlotManager(1)
    const order: string[] = []
    const running = pool.runExclusive(1, 'normal', async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('ch1')
    })
    const queued = pool.runExclusive(2, 'normal', async () => {
      order.push('ch2-normal')
    })
    await new Promise((r) => setTimeout(r, 5))
    const guidance = pool.runExclusive(3, 'guidance', async () => {
      order.push('ch3-guidance')
    })
    await Promise.all([running, queued, guidance])
    expect(order.indexOf('ch3-guidance')).toBeLessThan(order.indexOf('ch2-normal'))
  })
})

describe('isolation ledger', () => {
  it('isolate → skip → release on successful regen (spec 4.2.4 / 5.6.1 rule 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-'))
    const ledger = new IsolationLedger(join(dir, 'isolation.json'))
    await ledger.load()
    await ledger.isolate({ chapter: 12, reason: '审查超限', kind: 'review-limit', rewriteSummary: '定向2轮/全量1次' })
    expect(ledger.isIsolated(12)).toBe(true)
    expect(ledger.list()[0].chapter).toBe(12)
    const released = await ledger.release(12)
    expect(released).toBe(true)
    expect(ledger.isIsolated(12)).toBe(false)
    expect(await ledger.release(12)).toBe(false)
  })

  it('persists across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-'))
    const first = new IsolationLedger(join(dir, 'isolation.json'))
    await first.load()
    await first.isolate({ chapter: 7, reason: '连续失败', kind: 'consecutive-failures', rewriteSummary: '失败5次' })
    const second = new IsolationLedger(join(dir, 'isolation.json'))
    const list = await second.load()
    expect(list.map((i) => i.chapter)).toEqual([7])
  })
})