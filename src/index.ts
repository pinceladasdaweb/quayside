/**
 * quayside: generic idempotency for Node.js.
 *
 * The public API is frozen and tracked by the API Extractor report in
 * `etc/`; CI fails when exports drift from the committed report.
 *
 * @packageDocumentation
 */

export { Idempotency, isReplayedError } from './idempotency'
export type {
  ExecuteFunction,
  ExecuteInput,
  ExecutionContext,
  ExecutionResult,
  IdempotencyClock,
  IdempotencyOptions,
  IdempotencyRecord,
  WrapOptions
} from './idempotency'

export {
  ConcurrentExecutionError,
  ERROR_CODES,
  FencingError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyReuseError,
  QuaysideError,
  SerializationError,
  StorageCorruptError,
  StorageUnavailableError,
  WaitTimeoutError
} from './errors'
export type { QuaysideErrorCode } from './errors'

export { jsonCodec } from './codec'
export type { Codec } from './codec'

export { parseDuration } from './duration'
export type { Duration } from './duration'

// The storage-authoring helpers are public API: adapters (in-tree and
// external) must import their runtime values from this entry point, never
// from deep module paths - the build externalizes only the core bundle, so
// a deep import would inline a private copy of anything these helpers
// throw and break `instanceof` across entry points.
export { RECORD_STATUS, assertKeyBytes, buildStoredRecord, contendAcquire } from './storage'
export type {
  IdempotencyStorage,
  Outcome,
  PendingRecord,
  RawRecordFields,
  RecordStatus,
  StoredRecord
} from './storage'

export type {
  IdempotencyEvent,
  IdempotencyEventType,
  MetricsCollector
} from './events'
