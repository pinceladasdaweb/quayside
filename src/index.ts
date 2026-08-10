/**
 * quayside: generic idempotency for Node.js.
 *
 * The public API is frozen and tracked by the API Extractor report in
 * `etc/`; CI fails when exports drift from the committed report.
 *
 * @packageDocumentation
 */

export { Idempotency } from './idempotency'
export type {
  ExecuteFunction,
  ExecuteInput,
  ExecutionContext,
  ExecutionResult,
  IdempotencyOptions,
  IdempotencyRecord,
  WrapOptions
} from './idempotency'

export {
  ConcurrentExecutionError,
  ERROR_CODES,
  FencingError,
  IdempotencyKeyReuseError,
  QuaysideError,
  SerializationError,
  StorageUnavailableError,
  WaitTimeoutError
} from './errors'
export type { QuaysideErrorCode } from './errors'

export { jsonCodec } from './codec'
export type { Codec } from './codec'

export { parseDuration } from './duration'
export type { Duration } from './duration'

export { RECORD_STATUS } from './storage'
export type {
  IdempotencyStorage,
  Outcome,
  PendingRecord,
  RecordStatus,
  StoredRecord
} from './storage'

export type {
  IdempotencyEvent,
  IdempotencyEventType,
  MetricsCollector
} from './events'
