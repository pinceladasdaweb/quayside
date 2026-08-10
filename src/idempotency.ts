import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { jsonCodec, type Codec } from './codec'
import { parseDuration, type Duration } from './duration'
import {
  ConcurrentExecutionError,
  QuaysideError,
  StorageUnavailableError,
  WaitTimeoutError
} from './errors'
import { METRIC_HANDLERS, type IdempotencyEvent, type IdempotencyEventType, type MetricsCollector } from './events'
import { RECORD_STATUS, type IdempotencyStorage, type RecordStatus, type StoredRecord } from './storage'

export type ExecuteInput = string | { key: string }

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
  codec?: Codec
  /** Store and replay failures instead of allowing retries. Default: false. */
  persistFailures?: boolean
  onEvent? (event: IdempotencyEvent): void
  metrics?: MetricsCollector
}

function encodeErrorValue (error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
  }
  return JSON.stringify({ name: 'Error', message: String(error) })
}

function decodeErrorValue (encoded: string): Error {
  let parsed: { name?: string, message?: string, stack?: string }
  try {
    parsed = JSON.parse(encoded) as { name?: string, message?: string, stack?: string }
  } catch {
    parsed = { message: encoded }
  }
  const error = new Error(parsed.message ?? 'replayed failure')
  if (parsed.name !== undefined) error.name = parsed.name
  if (parsed.stack !== undefined) error.stack = parsed.stack
  return error
}

export class Idempotency {
  private readonly storage: IdempotencyStorage
  private readonly resultTtlMs: number
  private readonly lockTtlMs: number
  private readonly onConflict: 'reject' | 'wait'
  private readonly waitTimeoutMs: number
  private readonly namespace: string | undefined
  private readonly codec: Codec
  private readonly persistFailures: boolean
  private readonly onEvent: ((event: IdempotencyEvent) => void) | undefined
  private readonly metrics: MetricsCollector | undefined

  constructor (options: IdempotencyOptions) {
    this.storage = options.storage
    this.resultTtlMs = parseDuration(options.resultTtl ?? '24h')
    this.lockTtlMs = parseDuration(options.lockTtl ?? '30s')
    this.onConflict = options.onConflict ?? 'reject'
    this.waitTimeoutMs = parseDuration(options.waitTimeout ?? '10s')
    this.namespace = options.namespace
    this.codec = options.codec ?? jsonCodec
    this.persistFailures = options.persistFailures ?? false
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
    const key = this.normalizeKey(typeof input === 'string' ? input : input.key)
    const storageKey = this.composeKey(key)
    const token = randomUUID()
    const pending = { key: storageKey, token, storedAt: Date.now() }

    const existing = await this.storageCall(() => this.storage.acquire(pending, this.lockTtlMs))
    if (existing === null) {
      return this.runOwned(storageKey, key, token, pending.storedAt, fn, correlationId)
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

    await this.storageCall(() => this.storage.complete(storageKey, token, { status: 'completed', result: encoded }, this.resultTtlMs))
    this.emit('completed', key, correlationId)
    return { value, replayed: false, storedAt }
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
      await sleep(Math.min(delay, remaining))
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

  private composeKey (key: string): string {
    return this.namespace === undefined ? key : `${this.namespace}:${key}`
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
