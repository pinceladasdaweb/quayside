export type IdempotencyEventType =
  | 'acquired'
  | 'replayed'
  | 'conflict'
  | 'completed'
  | 'failed'
  | 'expired-recovery'
  | 'storage-bypass'

export interface IdempotencyEvent {
  type: IdempotencyEventType
  key: string
  namespace?: string
  correlationId: string
  timestamp: number
  /**
   * On terminal events (completed, replayed, failed): milliseconds since
   * the execute call started. A replayed duration approximates the time a
   * waiter spent blocked.
   */
  durationMs?: number
}

export interface MetricsCollector {
  onAcquired? (event: IdempotencyEvent): void
  onReplayed? (event: IdempotencyEvent): void
  onConflict? (event: IdempotencyEvent): void
  onCompleted? (event: IdempotencyEvent): void
  onFailed? (event: IdempotencyEvent): void
  onExpiredRecovery? (event: IdempotencyEvent): void
  onStorageBypass? (event: IdempotencyEvent): void
}

export const METRIC_HANDLERS = {
  acquired: 'onAcquired',
  replayed: 'onReplayed',
  conflict: 'onConflict',
  completed: 'onCompleted',
  failed: 'onFailed',
  'expired-recovery': 'onExpiredRecovery',
  'storage-bypass': 'onStorageBypass'
} as const satisfies Record<IdempotencyEventType, keyof MetricsCollector>
