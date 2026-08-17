import type { ProjectStatus } from './schema.js'

export type ProjectAction =
  | 'start'
  | 'planning-done'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'stop'

const TRANSITIONS: Record<ProjectStatus, Partial<Record<ProjectAction, ProjectStatus>>> = {
  pending: { start: 'planning' },
  planning: { 'planning-done': 'generating', pause: 'paused', stop: 'aborted' },
  generating: { pause: 'paused', complete: 'completed', stop: 'aborted' },
  paused: { resume: 'generating', stop: 'aborted' },
  completed: {},
  aborted: {},
}

export class InvalidStateError extends Error {
  readonly code = 'INVALID_STATE'
  constructor(
    readonly from: ProjectStatus,
    readonly action: ProjectAction,
  ) {
    super(`invalid state transition: cannot "${action}" from "${from}"`)
    this.name = 'InvalidStateError'
  }
}

export function canTransition(from: ProjectStatus, action: ProjectAction): boolean {
  return TRANSITIONS[from][action] !== undefined
}

export function transition(from: ProjectStatus, action: ProjectAction): ProjectStatus {
  const to = TRANSITIONS[from][action]
  if (to === undefined) throw new InvalidStateError(from, action)
  return to
}

export function allowedActions(from: ProjectStatus): ProjectAction[] {
  return Object.keys(TRANSITIONS[from]) as ProjectAction[]
}