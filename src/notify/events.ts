import type { HostEvent } from '../host/types.js'

export type DomainEventType =
  | 'project.created'
  | 'project.status'
  | 'chapter.status'
  | 'chapter.final'
  | 'chapter.isolated'
  | 'model.fallback'
  | 'model.plan-limit'
  | 'model.circuit-open'
  | 'pipeline.completed'
  | 'pipeline.aborted'
  | 'pipeline.error'

export interface DomainEvent extends HostEvent {
  type: DomainEventType | (string & {})
  projectId?: string
  chapter?: number
  message?: string
  timestamp: number
  [key: string]: unknown
}

export interface ProjectStatusEvent extends DomainEvent {
  type: 'project.status'
  projectId: string
  from: string
  to: string
}

export interface ChapterStatusEvent extends DomainEvent {
  type: 'chapter.status'
  projectId: string
  chapter: number
  stage: string
  status: string
}

export interface ModelFallbackEvent extends DomainEvent {
  type: 'model.fallback'
  projectId?: string
  from: string
  to: string
  reason: string
}

export interface PipelineCompletedEvent extends DomainEvent {
  type: 'pipeline.completed'
  projectId: string
  totalChapters: number
  finalCount: number
  isolated: number[]
  durationMs: number
}