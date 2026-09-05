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
  SerializationError,
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

/**
 * Everything one execution threads between run(), runOwned() and
 * waitForOutcome(). One object instead of adjacent same-typed positionals:
 * `key` and `storageKey` are both strings, and a silent swap at any of the
 * call sites would compile clean and only fail behaviorally.
 */
interface ExecutionFrame {
  input: ExecuteInput
  /** The caller's key, as events and errors name it. */
  key: string
  /** The composed (namespaced, encoded) key the storage is addressed by. */
  storageKey: string
  fingerprint: string | undefined
  correlationId: string
  startedAt: number
  /**
   * Resolved BEFORE the lock is taken: an invalid per-call TTL is caller
   * input, and rejecting it after acquire would leave the record in
   * progress with nothing to release it until the lock TTL ran out.
   */
  resultTtlMs: number
}

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

// Registered rather than unique for the same reason as the NestJS metadata
// key: this package ships dual CJS and ESM builds, and an error revived by
// one copy must test true in the other.
const REPLAYED_ERROR = Symbol.for('quayside:replayed-error')

/**
 * Whether an error was reconstructed from a stored record rather than
 * thrown by live code. Adapters that rebuild richer error shapes on replay
 * (the NestJS interceptor reviving an HttpException) must gate on this: a
 * LIVE foreign error can carry the same fields by coincidence - an HTTP
 * client error object, for instance - and rebuilding one of those would
 * leak whatever its shape holds.
 */
export function isReplayedError (error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, REPLAYED_ERROR) === true
}

function reviveError (serialized: SerializedError, depth = 0): Error {
  const options: ErrorOptions = {}
  // The same depth cap serialization applies: a record whose cause chain
  // was not written by this library (hand-made, tampered, another codec)
  // must not be able to recurse without a bound.
  if (serialized.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    options.cause = reviveError(serialized.cause, depth + 1)
  }
  const error = new Error(serialized.message, options)
  error.name = serialized.name
  if (serialized.stack !== undefined) error.stack = serialized.stack
  // defineProperty rather than assignment: JSON.parse creates '__proto__'
  // as an own key, and copying it through [[Set]] would run the prototype
  // setter and leave the revived error failing `instanceof Error`, which
  // the adapters branch on. Own data properties are what was serialized,
  // so own data properties are what comes back.
  for (const [field, value] of Object.entries(serialized.properties ?? {})) {
    Object.defineProperty(error, field, { value, writable: true, enumerable: true, configurable: true })
  }
  // Marked as a reconstruction (see isReplayedError). Non-enumerable so the
  // mark never travels: it states how THIS object came to exist.
  Object.defineProperty(error, REPLAYED_ERROR, { value: true })
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
    // Argument validation stays outside storageCall: a TypeError about the
    // caller's key is not a storage outage and must not be dressed as one.
    const storageKey = this.composeKey(this.normalizeKey(key))
    const record = await this.storageCall(() => this.storage.get(storageKey))
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
    const storageKey = this.composeKey(this.normalizeKey(key))
    await this.storageCall(() => this.storage.delete(storageKey))
  }

  private async run<T> (
    input: ExecuteInput,
    fn: ExecuteFunction<T>,
    correlationId: string,
    startedAt: number = this.clock.now()
  ): Promise<ExecutionResult<T>> {
    const { key, fingerprint } = this.resolveTarget(input)
    const frame: ExecutionFrame = {
      input,
      key,
      storageKey: this.composeKey(key),
      fingerprint,
      correlationId,
      startedAt,
      resultTtlMs: this.resultTtlFor(input)
    }
    const token = randomUUID()
    const pending = { key: frame.storageKey, token, fingerprint, storedAt: this.clock.now() }

    let existing: StoredRecord | null
    try {
      existing = await this.storageCall(() => this.storage.acquire(pending, this.lockTtlMs))
    } catch (error) {
      if (this.bypasses(error)) return this.runUnguarded(key, fn, correlationId)
      throw error
    }

    // A record carrying OUR token is ours: a driver that resent the acquire
    // after losing its reply (ioredis does so by default) reads the record
    // the first attempt wrote back as a conflict, and a per-call random
    // token can never coincide with a foreign record's. The adapters need
    // no knowledge of this; the engine minted the token, so it decides.
    if (existing === null || existing.token === token) {
      return this.runOwned(frame, token, pending.storedAt, fn)
    }

    const replay = this.settled<T>(frame, existing)
    if (replay !== undefined) return replay

    this.emit('conflict', key, correlationId)
    if (this.onConflict === 'reject') {
      throw new ConcurrentExecutionError(key)
    }
    return this.waitForOutcome(frame, fn, existing)
  }

  private async runOwned<T> (
    frame: ExecutionFrame,
    token: string,
    storedAt: number,
    fn: ExecuteFunction<T>
  ): Promise<ExecutionResult<T>> {
    const { storageKey, key, correlationId, startedAt, resultTtlMs } = frame
    this.emit('acquired', key, correlationId)
    const controller = new AbortController()
    let stores = true
    const ctx: ExecutionContext = {
      key,
      replayed: false,
      signal: controller.signal,
      extend: async (ttl) => {
        // Parsed outside storageCall: an invalid duration is the caller's
        // mistake, not an outage for fail-open to wave through.
        const lockTtlMs = ttl === undefined ? this.lockTtlMs : parseDuration(ttl)
        try {
          await this.storageCall(() => this.storage.extend(storageKey, token, lockTtlMs))
        } catch (error) {
          // Fail-open covers every storage interaction, not only the ones
          // around the execution: an outage mid-heartbeat must not abort a
          // function the instance chose to keep running unguarded.
          if (this.bypasses(error)) {
            this.emit('storage-bypass', key, correlationId)
            return
          }
          throw error
        }
      },
      doNotStore: () => { stores = false }
    }

    let value: T
    try {
      value = await fn(ctx)
    } catch (error) {
      const persisted = this.persistFailures && stores
      await this.settle(storageKey, token, persisted ? { status: 'failed', error: encodeErrorValue(error, this.codec) } : null, resultTtlMs)
      this.emit('failed', key, correlationId, startedAt)
      throw error
    }

    if (!stores) {
      // The execution opted out of storage: the caller gets its value, the
      // record is released, and nothing is left for anyone to replay.
      await this.settle(storageKey, token, null, resultTtlMs)
      this.emit('completed', key, correlationId, startedAt)
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
      this.emit('failed', key, correlationId, startedAt)
      throw error
    }

    try {
      await this.storageCall(() => this.storage.complete(storageKey, token, { status: 'completed', result: encoded }, resultTtlMs))
    } catch (error) {
      if (this.bypasses(error)) {
        // The function already ran; in fail-open mode the caller gets its
        // result even though it could not be stored for replay.
        this.emit('storage-bypass', key, correlationId)
        return { value, replayed: false, storedAt }
      }
      if (error instanceof SerializationError) {
        // The storage refused the encoded outcome (too large for its
        // record, say): the same contract as a codec that could not encode
        // it - the record is released so callers may retry, and the error
        // surfaces instead of leaving the key locked until the lock TTL.
        await this.settle(storageKey, token, null, resultTtlMs)
      }
      this.emit('failed', key, correlationId, startedAt)
      throw error
    }
    this.emit('completed', key, correlationId, startedAt)
    return { value, replayed: false, storedAt }
  }

  /**
   * What a record somebody else owns means for this call: a different
   * payload under the key is a reuse error, a terminal record is a replay
   * (the stored value, or the stored failure rethrown), and a record still
   * in progress is `undefined`: the caller decides whether to reject or
   * wait. One reading serves the acquire path and every poll of the wait
   * loop, so the two can never disagree on what a record means.
   */
  private settled<T> (frame: ExecutionFrame, record: StoredRecord): ExecutionResult<T> | undefined {
    const { key, fingerprint, correlationId, startedAt } = frame
    if (!fingerprintsEqual(record.fingerprint, fingerprint)) {
      throw new IdempotencyKeyReuseError(key)
    }
    if (record.status === RECORD_STATUS.inProgress) return undefined
    this.emit('replayed', key, correlationId, startedAt)
    if (record.status === RECORD_STATUS.failed) {
      throw decodeErrorValue(record.error ?? '', this.codec)
    }
    return { value: this.decodeResult(record) as T, replayed: true, storedAt: record.storedAt }
  }

  // The fail-open trade: an instance that chose availability treats a
  // genuine storage outage as permission to run unguarded. Only outages:
  // corruption and every other quayside error keep their meaning.
  private bypasses (error: unknown): boolean {
    return error instanceof StorageUnavailableError && this.failOpen
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
    frame: ExecutionFrame,
    fn: ExecuteFunction<T>,
    observed: StoredRecord
  ): Promise<ExecutionResult<T>> {
    const { storageKey, key, correlationId, startedAt } = frame
    // The deadline is measured from the call, not from this entry: a
    // waiter that takes over and loses the re-acquire race lands in a new
    // wait, and restarting the clock there would let sustained holder
    // churn block one execute() forever while waitTimeout, its documented
    // upper bound, never fired.
    const deadline = startedAt + this.waitTimeoutMs
    const notify = this.storage.waitForChange?.bind(this.storage)
    let warned = false
    let delay = 25
    while (true) {
      let record: StoredRecord | null
      try {
        record = await this.storageCall(() => this.storage.get(storageKey))
      } catch (error) {
        // The same trade-off the acquire path takes: an instance that
        // chose availability must not answer a storage outage with an
        // error just because it happened to be waiting when it hit.
        if (this.bypasses(error)) return this.runUnguarded(key, fn, correlationId)
        throw error
      }
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
        // The takeover re-enters run(), which may land back here when a
        // contender wins the race: without spending the same budget the
        // polls do, sustained churn would spin through that cycle with
        // neither a sleep nor a deadline in the way.
        if (deadline - this.clock.now() <= 0) {
          throw new WaitTimeoutError(key, this.waitTimeoutMs)
        }
        return this.run(frame.input, fn, correlationId, startedAt)
      }
      observed = record
      // The record under the key can change identity while we wait: the
      // holder's lock may expire and another payload take the key over. Its
      // outcome is not ours to replay, exactly as in the acquire path.
      const replay = this.settled<T>(frame, record)
      if (replay !== undefined) return replay
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
    } catch (error) {
      // An outcome the storage refuses as unstorable (too large for its
      // record) is released so callers may retry, the same contract the
      // success path applies to a codec that could not encode the value:
      // a persisted failure must not leave the key locked until the lock
      // TTL. Everything else (an outage, a lost lock) stays swallowed by
      // design: see above.
      if (error instanceof SerializationError) {
        try {
          await this.storage.release(storageKey, token)
        } catch {}
      }
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

  // Terminal events pass the instant the call started; one clock sample
  // then serves both fields, so `timestamp - durationMs` is exactly that
  // instant (the OTel collector backdates its spans by it).
  private emit (type: IdempotencyEventType, key: string, correlationId: string, startedAt?: number): void {
    const timestamp = this.clock.now()
    const event: IdempotencyEvent = { type, key, correlationId, timestamp }
    if (this.namespace !== undefined) event.namespace = this.namespace
    if (startedAt !== undefined) event.durationMs = timestamp - startedAt

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
