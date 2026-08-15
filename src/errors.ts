export const ERROR_CODES = {
  inProgress: 'IDEMPOTENCY_IN_PROGRESS',
  keyInvalid: 'IDEMPOTENCY_KEY_INVALID',
  keyReuse: 'IDEMPOTENCY_KEY_REUSE',
  waitTimeout: 'IDEMPOTENCY_WAIT_TIMEOUT',
  fencing: 'IDEMPOTENCY_FENCING',
  serialization: 'IDEMPOTENCY_SERIALIZATION',
  storageUnavailable: 'IDEMPOTENCY_STORAGE_UNAVAILABLE'
} as const

export type QuaysideErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class QuaysideError extends Error {
  readonly code: QuaysideErrorCode

  constructor (code: QuaysideErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class ConcurrentExecutionError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.inProgress
  readonly key: string

  constructor (key: string) {
    super(ERROR_CODES.inProgress, `an execution for key "${key}" is already in progress`)
    this.key = key
  }
}

/**
 * The key itself violates a policy limit. It carries a code (and maps to a
 * 4xx in the HTTP adapters) because the offending value is data, usually
 * supplied by a client, rather than a mistake in the calling code.
 */
export class IdempotencyKeyInvalidError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.keyInvalid
  readonly key: string

  constructor (key: string, message: string) {
    super(ERROR_CODES.keyInvalid, message)
    this.key = key
  }
}

export class IdempotencyKeyReuseError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.keyReuse
  readonly key: string

  constructor (key: string) {
    super(ERROR_CODES.keyReuse, `key "${key}" was already used with a different payload`)
    this.key = key
  }
}

export class WaitTimeoutError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.waitTimeout
  readonly key: string

  constructor (key: string, waitTimeoutMs: number) {
    super(ERROR_CODES.waitTimeout, `timed out after ${waitTimeoutMs}ms waiting for key "${key}" to complete`)
    this.key = key
  }
}

export class FencingError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.fencing
  readonly key: string

  constructor (key: string) {
    super(ERROR_CODES.fencing, `fencing token mismatch for key "${key}"; the lock is no longer held`)
    this.key = key
  }
}

export class SerializationError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.serialization

  constructor (message: string, options?: ErrorOptions) {
    super(ERROR_CODES.serialization, message, options)
  }
}

export class StorageUnavailableError extends QuaysideError {
  declare readonly code: typeof ERROR_CODES.storageUnavailable

  constructor (message: string, options?: ErrorOptions) {
    super(ERROR_CODES.storageUnavailable, message, options)
  }
}
