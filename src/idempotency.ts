import { randomUUID } from 'node:crypto'
import { setTimeout as sleepFor } from 'node:timers/promises'

import { fingerprintsEqual, hashCanonical } from './canonical'
import { jsonCodec, type Codec } from './codec'
import { parseDuration, type Duration } from './duration'
import {
  ConcurrentExecutionError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyReuseError,
  QuaysideError,
  StorageUnavailableError,
  WaitTimeoutError
} from './errors'
import { METRIC_HANDLERS, type IdempotencyEvent, type IdempotencyEventType, type MetricsCollector } from './events'
import { RECORD_STATUS, type IdempotencyStorage, type Outcome, type RecordStatus, type StoredRecord } from './storage'

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
    /**
     * Replay window for this call, overriding the instance `resultTtl`.
     * A per-route TTL is a property of the call, not a reason to build a
     * second engine around the same storage.
     */
    resultTtl?: Duration
  }

export interface ExecutionContext {
  key: string
  replayed: boolean
  signal: AbortSignal
  extend (ttl?: Duration): Promise<void>
  /**
   * Opts this execution out of storage entirely: the outcome reaches this
   * caller, the record is released, and the next call with the same key runs
   * fresh. Concurrent callers stay protected by the lock while it runs; only
   * the replay window is given up. Applies to failures too, overriding
   * `persistFailures` for this run.
   */
  doNotStore (): void
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

/**
 * Time seam: every timestamp and every wait in the engine goes through it,
 * so tests can drive time instead of sleeping. Production uses the wall
 * clock.
 */
export interface IdempotencyClock {
  now (): number
  sleep (ms: number): Promise<void>
}

const WALL_CLOCK: IdempotencyClock = {
  now: () => Date.now(),
  sleep: async (ms) => { await sleepFor(ms) }
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
  /** Time source and wait primitive; tests inject a manual clock. */
  clock?: IdempotencyClock
}

interface SerializedError {
  name: string
  message: string
  stack?: string
  properties?: Record<string, unknown>
  cause?: SerializedError
}

const MAX_CAUSE_DEPTH = 5

// Last-resort record for failures whose own serialization throws (a hostile
// getter, for instance); precomputed so this path cannot fail in turn.
const UNSERIALIZABLE_FAILURE = JSON.stringify({ name: 'Error', message: 'failure could not be serialized' })

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
  // Only defined values go in: the serialized shape travels through the
  // configured codec, and a codec is entitled to reject an undefined field.
  const serialized: SerializedError = { name: error.name, message: error.message }
  if (typeof error.stack === 'string') serialized.stack = error.stack
  const properties: Record<string, unknown> = {}
  for (const field of Object.keys(error)) {
    // Fields already captured above are excluded structurally; cause is
    // serialized recursively below instead of being JSON-flattened here.
    if (field === 'cause' || Object.hasOwn(serialized, field)) continue
    // Best-effort: a property that does not survive JSON is dropped; the
    // failure path must never raise a serialization error that masks the
    // original failure.
    try {
      properties[field] = JSON.parse(JSON.stringify((error as unknown as Record<string, unknown>)[field]))
    } catch {}
  }
  serialized.properties = properties
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(error.cause, depth + 1)
  }
  return serialized
}

function encodeErrorValue (error: unknown, codec: Codec): string {
  try {
    return codec.encode(serializeError(error))
  } catch {
    // Last resort, and deliberately not codec-encoded: whatever just failed
    // cannot be trusted to encode this either. It carries no caller data.
    return UNSERIALIZABLE_FAILURE
  }
}

function reviveError (serialized: SerializedError): Error {
  const options: ErrorOptions = {}
  if (serialized.cause !== undefined) options.cause = reviveError(serialized.cause)
  const error = new Error(serialized.message, options)
  error.name = serialized.name
  if (serialized.stack !== undefined) error.stack = serialized.stack
  // Object.assign ignores an undefined source, so hand-crafted or corrupt
  // records without properties revive cleanly.
  Object.assign(error, serialized.properties)
  return error
}

function decodeErrorValue (encoded: string, codec: Codec): Error {
  let parsed: unknown
  try {
    parsed = codec.decode(encoded)
  } catch {}
  // A hand-written record, or one written under a different codec, decodes
  // to something that is not a serialized error. The raw text is then the
  // most honest message available, and beats throwing over the failure the
  // caller was actually asking about.
  if (parsed === null || typeof parsed !== 'object') {
    return reviveError({ name: 'Error', message: encoded })
  }
  return reviveError(parsed as SerializedError)
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
  private readonly failOpen: boolean
  private readonly onEvent: ((event: IdempotencyEvent) => void) | undefined
  private readonly metrics: MetricsCollector | undefined
  private readonly clock: IdempotencyClock

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
    this.failOpen = options.onStorageError === 'open'
    this.onEvent = options.onEvent
    this.metrics = options.metrics
    this.clock = options.clock ?? WALL_CLOCK
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
      result.error = decodeErrorValue(record.error, this.codec)
    }
    return result
  }

  async invalidate (key: string): Promise<void> {
    await this.storageCall(() => this.storage.delete(this.composeKey(this.normalizeKey(key))))
  }

  private async run<T> (
    input: ExecuteInput,
    fn: ExecuteFunction<T>,
    correlationId: string,
    startedAt: number = this.clock.now()
  ): Promise<ExecutionResult<T>> {
    const { key, fingerprint } = this.resolveTarget(input)
    const storageKey = this.composeKey(key)
    const token = randomUUID()
    const pending = { key: storageKey, token, fingerprint, storedAt: this.clock.now() }

    let existing: StoredRecord | null
    try {
      existing = await this.storageCall(() => this.storage.acquire(pending, this.lockTtlMs))
    } catch (error) {
      if (error instanceof StorageUnavailableError && this.failOpen) {
        return this.runUnguarded(key, fn, correlationId)
      }
      throw error
    }

    if (existing === null) {
      return this.runOwned(storageKey, key, token, pending.storedAt, fn, correlationId, startedAt, this.resultTtlFor(input))
    }

    if (!fingerprintsEqual(existing.fingerprint, fingerprint)) {
      throw new IdempotencyKeyReuseError(key)
    }

    if (existing.status === RECORD_STATUS.completed) {
      this.emit('replayed', key, correlationId, this.clock.now() - startedAt)
      return { value: this.decodeResult(existing) as T, replayed: true, storedAt: existing.storedAt }
    }
    if (existing.status === RECORD_STATUS.failed) {
      this.emit('replayed', key, correlationId, this.clock.now() - startedAt)
      throw decodeErrorValue(existing.error ?? '', this.codec)
    }

    this.emit('conflict', key, correlationId)
    if (this.onConflict === 'reject') {
      throw new ConcurrentExecutionError(key)
    }
    return this.waitForOutcome(input, storageKey, key, fingerprint, fn, correlationId, startedAt, existing)
  }

  private async runOwned<T> (
    storageKey: string,
    key: string,
    token: string,
    storedAt: number,
    fn: ExecuteFunction<T>,
    correlationId: string,
    startedAt: number,
    resultTtlMs: number
  ): Promise<ExecutionResult<T>> {
    this.emit('acquired', key, correlationId)
    const controller = new AbortController()
    let stores = true
    const ctx: ExecutionContext = {
      key,
      replayed: false,
      signal: controller.signal,
      extend: async (ttl) => {
        await this.storageCall(() => this.storage.extend(storageKey, token, ttl === undefined ? this.lockTtlMs : parseDuration(ttl)))
      },
      doNotStore: () => { stores = false }
    }

    let value: T
    try {
      value = await fn(ctx)
    } catch (error) {
      const persisted = this.persistFailures && stores
      await this.settle(storageKey, token, persisted ? { status: 'failed', error: encodeErrorValue(error, this.codec) } : null, resultTtlMs)
      this.emit('failed', key, correlationId, this.clock.now() - startedAt)
      throw error
    }

    if (!stores) {
      // The execution opted out of storage: the caller gets its value, the
      // record is released, and nothing is left for anyone to replay.
      await this.settle(storageKey, token, null, resultTtlMs)
      this.emit('completed', key, correlationId, this.clock.now() - startedAt)
      return { value, replayed: false, storedAt }
    }

    let encoded: string
    try {
      encoded = this.codec.encode(value)
    } catch (error) {
      // A result that cannot be stored cannot be replayed either: the record
      // is released so callers may retry, and the error surfaces instead of
      // silently storing something else.
      await this.settle(storageKey, token, null, resultTtlMs)
      this.emit('failed', key, correlationId, this.clock.now() - startedAt)
      throw error
    }

    try {
      await this.storageCall(() => this.storage.complete(storageKey, token, { status: 'completed', result: encoded }, resultTtlMs))
    } catch (error) {
      if (error instanceof StorageUnavailableError && this.failOpen) {
        // The function already ran; in fail-open mode the caller gets its
        // result even though it could not be stored for replay.
        this.emit('storage-bypass', key, correlationId)
        return { value, replayed: false, storedAt }
      }
      this.emit('failed', key, correlationId, this.clock.now() - startedAt)
      throw error
    }
    this.emit('completed', key, correlationId, this.clock.now() - startedAt)
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
      // Nothing is locked and nothing is stored: both are already no-ops.
      extend: async () => {},
      doNotStore: () => {}
    })
    return { value, replayed: false, storedAt: this.clock.now() }
  }

  private async waitForOutcome<T> (
    input: ExecuteInput,
    storageKey: string,
    key: string,
    fingerprint: string | undefined,
    fn: ExecuteFunction<T>,
    correlationId: string,
    startedAt: number,
    observed: StoredRecord
  ): Promise<ExecutionResult<T>> {
    const deadline = this.clock.now() + this.waitTimeoutMs
    const notify = this.storage.waitForChange?.bind(this.storage)
    let warned = false
    let delay = 25
    while (true) {
      const record = await this.storageCall(() => this.storage.get(storageKey))
      if (record === null) {
        // The holder failed (record deleted) or its lock expired: take over.
        // Which one it was is worth telling apart: a lock that ran out its
        // TTL means a holder died or stalled mid-execution, the signal
        // dashboards watch for. The storage cannot report it (expired reads
        // as absent by contract), but this waiter saw the record before it
        // vanished and knows whether its lease had run out.
        if (observed.expiresAt <= this.clock.now()) {
          this.emit('expired-recovery', key, correlationId)
        }
        return this.run(input, fn, correlationId, startedAt)
      }
      observed = record
      // The record under the key can change identity while we wait: the
      // holder's lock may expire and another payload take the key over. Its
      // outcome is not ours to replay, exactly as in the acquire path.
      if (!fingerprintsEqual(record.fingerprint, fingerprint)) {
        throw new IdempotencyKeyReuseError(key)
      }
      if (record.status === RECORD_STATUS.completed) {
        this.emit('replayed', key, correlationId, this.clock.now() - startedAt)
        return { value: this.decodeResult(record) as T, replayed: true, storedAt: record.storedAt }
      }
      if (record.status === RECORD_STATUS.failed) {
        this.emit('replayed', key, correlationId, this.clock.now() - startedAt)
        throw decodeErrorValue(record.error ?? '', this.codec)
      }
      const remaining = deadline - this.clock.now()
      if (remaining <= 0) {
        throw new WaitTimeoutError(key, this.waitTimeoutMs)
      }
      const pause = Math.min(delay, remaining)
      // Storage-assisted wake-up with the polling pause as its upper bound.
      // A storage without a channel simply polls; one whose channel is
      // broken polls too, but says so once instead of degrading in silence.
      if (notify === undefined) {
        await this.clock.sleep(pause)
      } else {
        let woke = false
        try {
          // Calling .then() doubles as the contract check: a channel that
          // hands back something other than a promise throws right here
          // rather than passing for an instant wake-up that would spin.
          await notify(storageKey, pause).then(() => {})
          woke = true
        } catch (error) {
          if (!warned) {
            warned = true
            process.emitWarning(`quayside notification channel failed for "${key}"; falling back to polling: ${String(error)}`)
          }
        }
        if (!woke) await this.clock.sleep(pause)
      }
      delay = Math.min(delay * 2, 1_000)
    }
  }

  // Terminal write for an execution that stores no result: `null` releases
  // the record, an outcome persists it. Best-effort by design: the caller's
  // own result or failure must surface even when this write loses the lock
  // or the storage is down.
  private async settle (storageKey: string, token: string, outcome: Outcome | null, resultTtlMs: number): Promise<void> {
    try {
      if (outcome === null) await this.storage.release(storageKey, token)
      else await this.storage.complete(storageKey, token, outcome, resultTtlMs)
    } catch {
      // Swallowed by design: see above.
    }
  }

  private resultTtlFor (input: ExecuteInput): number {
    // Reading the property off the string form yields undefined, so the two
    // input shapes need no separate check.
    const perCall = (input as { resultTtl?: Duration }).resultTtl
    return perCall === undefined ? this.resultTtlMs : parseDuration(perCall)
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
      throw new IdempotencyKeyInvalidError(
        key,
        `composed idempotency key is ${composed.length} characters long and exceeds maxKeyLength (${this.maxKeyLength})`
      )
    }
    return composed
  }

  private emit (type: IdempotencyEventType, key: string, correlationId: string, durationMs?: number): void {
    const event: IdempotencyEvent = { type, key, correlationId, timestamp: this.clock.now() }
    if (this.namespace !== undefined) event.namespace = this.namespace
    if (durationMs !== undefined) event.durationMs = durationMs

    const listeners: Array<(event: IdempotencyEvent) => void> = []
    if (this.onEvent !== undefined) listeners.push(this.onEvent)
    const metrics = this.metrics
    if (metrics !== undefined) {
      const handler = metrics[METRIC_HANDLERS[type]]
      if (handler !== undefined) listeners.push((payload) => handler.call(metrics, payload))
    }
    for (const listener of listeners) {
      // Observability must never alter execution semantics, but a broken
      // listener is not silent either: it surfaces as a process warning.
      try {
        listener(event)
      } catch (error) {
        process.emitWarning(`quayside ${type} listener failed: ${String(error)}`)
      }
    }
  }
}
