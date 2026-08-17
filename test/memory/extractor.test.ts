import { describe, expect, it } from 'vitest'
import { extractFromFinal, parseSpatiotemporalFromTail } from '../../src/memory/extractor'
import type { CharacterTierCN } from '../../src/memory/matrix-store'

const tiers = new Map<string, CharacterTierCN>([
  ['沈孤鸿', '主角'],
  ['白老板', '重要配角'],
  ['卖花老人', '路人'],
])

const locations = ['长街', '雪山山洞', '临海小镇', '渡口']

describe('extractor', () => {
  it('foreshadow plan co-present in text is extracted', () => {
    const result = extractFromFinal({
      finalText: '沈孤鸿摩挲着那柄断刀，刀身上的裂痕像一道旧伤。白老板递来一盏灯。',
      outline: { chapter: 3, foreshadowPlan: [{ title: '断刀', action: 'planted' }, { title: '遗失的地图', action: 'planted' }] },
      characterTiers: tiers,
      locationNames: locations,
    })
    expect(result.foreshadowOps).toEqual([{ title: '断刀', action: 'planted' }])
  })

  it('motif lexicon hits recorded', () => {
    const result = extractFromFinal({
      finalText: '雪落着，刀出鞘，灯灭了。',
      outline: { chapter: 1 },
      characterTiers: tiers,
      locationNames: locations,
    })
    expect(result.motifsHit).toEqual(expect.arrayContaining(['雪', '刀', '灯']))
  })

  it('character appearances detected with protagonist update note', () => {
    const result = extractFromFinal({
      finalText: '沈孤鸿走进长街，白老板在门口，卖花老人挑着担子经过。',
      outline: { chapter: 2 },
      characterTiers: tiers,
      locationNames: locations,
    })
    expect(result.characterAppearances.sort()).toEqual(['卖花老人', '沈孤鸿', '白老板'].sort())
    expect(result.protagonistUpdates.map((u) => u.name)).toEqual(['沈孤鸿'])
  })

  it('spacetime parsed from tail paragraph (spec 5.5.1 rule 6)', () => {
    const text = [
      '沈孤鸿清晨出了临海小镇，沿着官道向西。',
      '中段赶路。',
      '三日后，他抵达雪山山洞，洞口的风像刀子。',
    ].join('\n')
    const entry = parseSpatiotemporalFromTail(text, 8, locations)
    expect(entry).not.toBeNull()
    expect(entry!.endScene.location).toBe('雪山山洞')
    expect(entry!.startScene.location).toBe('临海小镇')
    expect(entry!.timeline).toBe('三天后')
  })

  it('no known location in tail → null (triggers archivist fallback)', () => {
    const text = '他们走了很久，来到一个没有名字的地方。'
    expect(parseSpatiotemporalFromTail(text, 9, locations)).toBeNull()
  })
})