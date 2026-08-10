export type IdempotencyEventType =
  | 'acquired'
  | 'replayed'
  | 'conflict'
  | 'completed'
  | 'failed'
  | 'expired-recovery'

export interface IdempotencyEvent {
  type: IdempotencyEventType
  key: string
  namespace?: string
  correlationId: string
  timestamp: number
}

export interface MetricsCollector {
  onAcquired? (event: IdempotencyEvent): void
  onReplayed? (event: IdempotencyEvent): void
  onConflict? (event: IdempotencyEvent): void
  onCompleted? (event: IdempotencyEvent): void
  onFailed? (event: IdempotencyEvent): void
  onExpiredRecovery? (event: IdempotencyEvent): void
}

export const METRIC_HANDLERS = {
  acquired: 'onAcquired',
  replayed: 'onReplayed',
  conflict: 'onConflict',
  completed: 'onCompleted',
  failed: 'onFailed',
  'expired-recovery': 'onExpiredRecovery'
} as const satisfies Record<IdempotencyEventType, keyof MetricsCollector>
