import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { fingerprintsEqual, hashCanonical } from './canonical'
import { jsonCodec, type Codec } from './codec'
import { parseDuration, type Duration } from './duration'
import {
  ConcurrentExecutionError,
  IdempotencyKeyReuseError,
  QuaysideError,
  StorageUnavailableError,
  WaitTimeoutError
} from './errors'
import { METRIC_HANDLERS, type IdempotencyEvent, type IdempotencyEventType, type MetricsCollector } from './events'
import { RECORD_STATUS, type IdempotencyStorage, type RecordStatus, type StoredRecord } from './storage'

export type ExecuteInput =
  | string
  | {
    /** Explicit intent key. Optional only when a payload derives one. */
    key?: string
    /**
     * Fingerprinted to validate key reuse; when no key is given, the
     * canonical hash of the payload becomes the key (opt-in convenience).
     */
    payload?: unknown
    /** Dot-separated payload paths excluded from the fingerprint. */
    ignoreFields?: string[]
    /** Dot-separated payload paths that alone form the fingerprint. */
    pickFields?: string[]
  }

export interface ExecutionContext {
  key: string
  replayed: boolean
  signal: AbortSignal
  extend (ttl?: Duration): Promise<void>
}

export type ExecuteFunction<T> = (ctx: ExecutionContext) => T | Promise<T>

export interface ExecutionResult<T> {
  value: T
  replayed: boolean
  storedAt: number
}

export interface IdempotencyRecord {
  key: string
  status: RecordStatus
  value?: unknown
  error?: Error
  storedAt: number
  expiresAt: number
}

export interface WrapOptions<TArgs extends unknown[]> {
  key (...args: TArgs): string
}

export interface IdempotencyOptions {
  storage: IdempotencyStorage
  /** How long a completed result stays replayable. Default: '24h'. */
  resultTtl?: Duration
  /** How long an in-progress record survives without completion. Default: '30s'. */
  lockTtl?: Duration
  /** What to do when the key is already executing. Default: 'reject'. */
  onConflict?: 'reject' | 'wait'
  /** Upper bound for onConflict: 'wait'. Default: '10s'. */
  waitTimeout?: Duration
  /** Key prefix that isolates domains sharing one storage. */
  namespace?: string
  /** Maximum length of the composed storage key; longer keys are rejected. Default: 512. */
  maxKeyLength?: number
  codec?: Codec
  /** Store and replay failures instead of allowing retries. Default: false. */
  persistFailures?: boolean
  /**
   * 'closed' (default) refuses to run when the storage is unavailable.
   * 'open' runs without the exactly-once guarantee and emits a
   * 'storage-bypass' event for every unguarded execution.
   */
  onStorageError?: 'closed' | 'open'
  onEvent? (event: IdempotencyEvent): void
  metrics?: MetricsCollector
}

interface SerializedError {
  name: string
  message: string
  stack?: string
  properties?: Record<string, unknown>
  cause?: SerializedError
}

const ERROR_CORE_FIELDS = new Set(['name', 'message', 'stack', 'cause'])
const MAX_CAUSE_DEPTH = 5

function serializeError (error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    let message: string
    try {
      message = String(error)
    } catch {
      message = 'unknown failure'
    }
    return { name: 'Error', message }
  }
  const serialized: SerializedError = { name: error.name, message: error.message }
  if (typeof error.stack === 'string') serialized.stack = error.stack
  const properties: Record<string, unknown> = {}
  for (const field of Object.keys(error)) {
    if (ERROR_CORE_FIELDS.has(field)) continue
    // Best-effort: a property that does not survive JSON is dropped; the
    // failure path must never raise a serialization error that masks the
    // original failure.
    try {
      properties[field] = JSON.parse(JSON.stringify((error as unknown as Record<string, unknown>)[field]))
    } catch {}
  }
  if (Object.keys(properties).length > 0) serialized.properties = properties
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(error.cause, depth + 1)
  }
  return serialized
}

function encodeErrorValue (error: unknown): string {
  try {
    return JSON.stringify(serializeError(error))
  } catch {
    return JSON.stringify({ name: 'Error', message: 'failure could not be serialized' })
  }
}

function reviveError (serialized: SerializedError): Error {
  const options: ErrorOptions = {}
  if (serialized.cause !== undefined) options.cause = reviveError(serialized.cause)
  const error = new Error(serialized.message, options)
  error.name = serialized.name
  if (serialized.stack !== undefined) error.stack = serialized.stack
  if (serialized.properties !== undefined) Object.assign(error, serialized.properties)
  return error
}

function decodeErrorValue (encoded: string): Error {
  let parsed: SerializedError
  try {
    parsed = JSON.parse(encoded) as SerializedError
  } catch {
    parsed = { name: 'Error', message: encoded }
  }
  return reviveError(parsed)
}

export class Idempotency {
  private readonly storage: IdempotencyStorage
  private readonly resultTtlMs: number
  private readonly lockTtlMs: number
  private readonly onConflict: 'reject' | 'wait'
  private readonly waitTimeoutMs: number
  private readonly namespace: string | undefined
  private readonly maxKeyLength: number
  private readonly codec: Codec
  private readonly persistFailures: boolean
  private readonly onStorageError: 'closed' | 'open'
  private readonly onEvent: ((event: IdempotencyEvent) => void) | undefined
  private readonly metrics: MetricsCollector | undefined

  constructor (options: IdempotencyOptions) {
    this.storage = options.storage
    this.resultTtlMs = parseDuration(options.resultTtl ?? '24h')
    this.lockTtlMs = parseDuration(options.lockTtl ?? '30s')
    this.onConflict = options.onConflict ?? 'reject'
    this.waitTimeoutMs = parseDuration(options.waitTimeout ?? '10s')
    this.namespace = options.namespace
    this.maxKeyLength = options.maxKeyLength ?? 512
    this.codec = options.codec ?? jsonCodec
    this.persistFailures = options.persistFailures ?? false
    this.onStorageError = options.onStorageError ?? 'closed'
    this.onEvent = options.onEvent
    this.metrics = options.metrics
  }

  async execute<T> (input: ExecuteInput, fn: ExecuteFunction<T>): Promise<T> {
    const { value } = await this.run(input, fn, randomUUID())
    return value
  }

  async executeWithMetadata<T> (input: ExecuteInput, fn: ExecuteFunction<T>): Promise<ExecutionResult<T>> {
    return this.run(input, fn, randomUUID())
  }

  wrap<TArgs extends unknown[], TResult> (
    fn: (...args: TArgs) => TResult | Promise<TResult>,
    options: WrapOptions<TArgs>
  ): (...args: TArgs) => Promise<TResult> {
    return (...args) => this.execute(options.key(...args), () => fn(...args))
  }

  async get (key: string): Promise<IdempotencyRecord | null> {
    const record = await this.storageCall(() => this.storage.get(this.composeKey(this.normalizeKey(key))))
    if (record === null) return null
    const result: IdempotencyRecord = {
      key,
      status: record.status,
      storedAt: record.storedAt,
      expiresAt: record.expiresAt
    }
    if (record.status === RECORD_STATUS.completed) result.value = this.decodeResult(record)
    if (record.status === RECORD_STATUS.failed && record.error !== undefined) {
      result.error = decodeErrorValue(record.error)
    }
    return result
  }

  async invalidate (key: string): Promise<void> {
    await this.storageCall(() => this.storage.delete(this.composeKey(this.normalizeKey(key))))
  }

  private async run<T> (
    input: ExecuteInput,
    fn: ExecuteFunction<T>,
    correlationId: string
  ): Promise<ExecutionResult<T>> {
    const { key, fingerprint } = this.resolveTarget(input)
    const storageKey = this.composeKey(key)
    const token = randomUUID()
    const pending = { key: storageKey, token, fingerprint, storedAt: Date.now() }

    let existing: StoredRecord | null
    try {
      existing = await this.storageCall(() => this.storage.acquire(pending, this.lockTtlMs))
    } catch (error) {
      if (error instanceof StorageUnavailableError && this.onStorageError === 'open') {
        return this.runUnguarded(key, fn, correlationId)
      }
      throw error
    }

    if (existing === null) {
      return this.runOwned(storageKey, key, token, pending.storedAt, fn, correlationId)
    }

    if (!fingerprintsEqual(existing.fingerprint, fingerprint)) {
      throw new IdempotencyKeyReuseError(key)
    }

    if (existing.status === RECORD_STATUS.completed) {
      this.emit('replayed', key, correlationId)
      return { value: this.decodeResult(existing) as T, replayed: true, storedAt: existing.storedAt }
    }
    if (existing.status === RECORD_STATUS.failed) {
      this.emit('replayed', key, correlationId)
      throw decodeErrorValue(existing.error ?? '')
    }

    this.emit('conflict', key, correlationId)
    if (this.onConflict === 'reject') {
      throw new ConcurrentExecutionError(key)
    }
    return this.waitForOutcome(input, storageKey, key, fn, correlationId)
  }

  private async runOwned<T> (
    storageKey: string,
    key: string,
    token: string,
    storedAt: number,
    fn: ExecuteFunction<T>,
    correlationId: string
  ): Promise<ExecutionResult<T>> {
    this.emit('acquired', key, correlationId)
    const controller = new AbortController()
    const ctx: ExecutionContext = {
      key,
      replayed: false,
      signal: controller.signal,
      extend: async (ttl) => {
        await this.storageCall(() => this.storage.extend(storageKey, token, ttl === undefined ? this.lockTtlMs : parseDuration(ttl)))
      }
    }

    let value: T
    try {
      value = await fn(ctx)
    } catch (error) {
      await this.settleFailure(storageKey, token, error)
      this.emit('failed', key, correlationId)
      throw error
    }

    let encoded: string
    try {
      encoded = this.codec.encode(value)
    } catch (error) {
      // A result that cannot be stored cannot be replayed either: the record
      // is released so callers may retry, and the error surfaces instead of
      // silently storing something else.
      await this.settleFailure(storageKey, token, error, { forceRelease: true })
      this.emit('failed', key, correlationId)
      throw error
    }

    try {
      await this.storageCall(() => this.storage.complete(storageKey, token, { status: 'completed', result: encoded }, this.resultTtlMs))
    } catch (error) {
      if (error instanceof StorageUnavailableError && this.onStorageError === 'open') {
        // The function already ran; in fail-open mode the caller gets its
        // result even though it could not be stored for replay.
        this.emit('storage-bypass', key, correlationId)
        return { value, replayed: false, storedAt }
      }
      this.emit('failed', key, correlationId)
      throw error
    }
    this.emit('completed', key, correlationId)
    return { value, replayed: false, storedAt }
  }

  // Fail-open execution: the storage is unreachable and the instance opted
  // into availability over the exactly-once guarantee. Nothing is locked or
  // stored; every bypassed execution is observable via 'storage-bypass'.
  private async runUnguarded<T> (
    key: string,
    fn: ExecuteFunction<T>,
    correlationId: string
  ): Promise<ExecutionResult<T>> {
    this.emit('storage-bypass', key, correlationId)
    const controller = new AbortController()
    const value = await fn({
      key,
      replayed: false,
      signal: controller.signal,
      extend: async () => {}
    })
    return { value, replayed: false, storedAt: Date.now() }
  }

  private async waitForOutcome<T> (
    input: ExecuteInput,
    storageKey: string,
    key: string,
    fn: ExecuteFunction<T>,
    correlationId: string
  ): Promise<ExecutionResult<T>> {
    const deadline = Date.now() + this.waitTimeoutMs
    let delay = 25
    while (true) {
      const record = await this.storageCall(() => this.storage.get(storageKey))
      if (record === null) {
        // The holder failed (record deleted) or its lock expired: take over.
        return this.run(input, fn, correlationId)
      }
      if (record.status === RECORD_STATUS.completed) {
        this.emit('replayed', key, correlationId)
        return { value: this.decodeResult(record) as T, replayed: true, storedAt: record.storedAt }
      }
      if (record.status === RECORD_STATUS.failed) {
        this.emit('replayed', key, correlationId)
        throw decodeErrorValue(record.error ?? '')
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new WaitTimeoutError(key, this.waitTimeoutMs)
      }
      const pause = Math.min(delay, remaining)
      if (typeof this.storage.waitForChange === 'function') {
        // Storage-assisted wake-up with the polling pause as its upper
        // bound; a broken notification channel degrades to plain polling.
        try {
          await this.storage.waitForChange(storageKey, pause)
        } catch {
          await sleep(pause)
        }
      } else {
        await sleep(pause)
      }
      delay = Math.min(delay * 2, 1_000)
    }
  }

  // Cleanup after a failed or unstorable execution. Every path here is
  // best-effort: the original failure must surface even when the cleanup
  // itself loses the lock or the storage is down.
  private async settleFailure (
    storageKey: string,
    token: string,
    error: unknown,
    options: { forceRelease?: boolean } = {}
  ): Promise<void> {
    try {
      if (this.persistFailures && options.forceRelease !== true) {
        await this.storage.complete(storageKey, token, { status: 'failed', error: encodeErrorValue(error) }, this.resultTtlMs)
      } else {
        await this.storage.release(storageKey, token)
      }
    } catch {
      // Swallowed by design: see above.
    }
  }

  private resolveTarget (input: ExecuteInput): { key: string, fingerprint?: string } {
    if (typeof input === 'string') {
      return { key: this.normalizeKey(input) }
    }
    const { key, payload, ignoreFields, pickFields } = input
    if (ignoreFields !== undefined && pickFields !== undefined) {
      throw new TypeError('ignoreFields and pickFields are mutually exclusive')
    }
    if ((ignoreFields !== undefined || pickFields !== undefined) && payload === undefined) {
      throw new TypeError('ignoreFields and pickFields require a payload')
    }
    const fingerprint = payload === undefined ? undefined : hashCanonical(payload, { ignoreFields, pickFields })
    if (key !== undefined) {
      return { key: this.normalizeKey(key), fingerprint }
    }
    if (fingerprint === undefined) {
      throw new TypeError('an idempotency key or a payload to derive one from is required')
    }
    return { key: fingerprint, fingerprint }
  }

  private async storageCall<T> (operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof QuaysideError) throw error
      throw new StorageUnavailableError('storage operation failed', { cause: error })
    }
  }

  private decodeResult (record: StoredRecord): unknown {
    return record.result === undefined ? undefined : this.codec.decode(record.result)
  }

  private normalizeKey (key: string): string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('idempotency key must be a non-empty string')
    }
    return key
  }

  // Segments are percent-encoded before composition so a client-supplied
  // key can never inject the separator and impersonate another namespace;
  // oversized keys are rejected, never truncated (truncation is a silent
  // collision).
  private composeKey (key: string): string {
    const encodedKey = encodeURIComponent(key)
    const composed = this.namespace === undefined
      ? encodedKey
      : `${encodeURIComponent(this.namespace)}:${encodedKey}`
    if (composed.length > this.maxKeyLength) {
      throw new TypeError(`composed idempotency key is ${composed.length} characters long and exceeds maxKeyLength (${this.maxKeyLength})`)
    }
    return composed
  }

  private emit (type: IdempotencyEventType, key: string, correlationId: string): void {
    const event: IdempotencyEvent = { type, key, correlationId, timestamp: Date.now() }
    if (this.namespace !== undefined) event.namespace = this.namespace
    // Observability must never alter execution semantics: listener failures
    // are swallowed.
    try {
      this.onEvent?.(event)
    } catch {}
    try {
      this.metrics?.[METRIC_HANDLERS[type]]?.(event)
    } catch {}
  }
}
