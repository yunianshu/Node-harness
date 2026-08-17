import { describe, expect, it } from 'vitest'
import { InvalidStateError, allowedActions, canTransition, transition } from '../../src/project/state-machine'

describe('project state machine', () => {
  it('follows legal happy path', () => {
    expect(transition('pending', 'start')).toBe('planning')
    expect(transition('planning', 'planning-done')).toBe('generating')
    expect(transition('generating', 'complete')).toBe('completed')
  })

  it('supports pause/resume cycle', () => {
    expect(transition('generating', 'pause')).toBe('paused')
    expect(transition('paused', 'resume')).toBe('generating')
    expect(transition('planning', 'pause')).toBe('paused')
  })

  it('supports stop from paused and generating', () => {
    expect(transition('paused', 'stop')).toBe('aborted')
    expect(transition('generating', 'stop')).toBe('aborted')
  })

  it('rejects all illegal transitions', () => {
    const illegal: Array<[from: Parameters<typeof transition>[0], action: Parameters<typeof transition>[1]]> = [
      ['pending', 'pause'],
      ['pending', 'resume'],
      ['pending', 'complete'],
      ['completed', 'resume'],
      ['completed', 'start'],
      ['aborted', 'resume'],
      ['aborted', 'start'],
      ['paused', 'complete'],
      ['planning', 'complete'],
      ['generating', 'start'],
      ['paused', 'planning-done'],
    ]
    for (const [from, action] of illegal) {
      expect(() => transition(from, action), `${from} -${action}-> should fail`).toThrow(InvalidStateError)
      expect(canTransition(from, action)).toBe(false)
    }
  })

  it('allowedActions lists guards per state', () => {
    expect(allowedActions('completed')).toEqual([])
    expect(allowedActions('pending')).toEqual(['start'])
    expect(allowedActions('paused').sort()).toEqual(['resume', 'stop'])
  })
})