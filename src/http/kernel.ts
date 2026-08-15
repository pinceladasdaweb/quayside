// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold against errors thrown by the
// user's Idempotency instance, so the build maps '../index' onto the shipped
// core bundle instead of inlining a private copy.
import {
  ConcurrentExecutionError,
  IdempotencyKeyReuseError,
  QuaysideError,
  WaitTimeoutError
} from '../index'
import type { Idempotency } from '../index'

export interface HttpRequestFacts {
  method: string
  path: string
  /** The parsed or raw request body, used only for fingerprinting. */
  body?: unknown
  header (name: string): string | undefined
}

/** What replay stores and serves back: status + selected headers + body. */
export interface CapturedHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type FingerprintStrategy =
  | 'body'
  | 'body-and-path'
  | ((request: HttpRequestFacts) => unknown)

export interface HttpKernelOptions {
  /** Header carrying the idempotency key. Default: 'Idempotency-Key'. */
  header?: string
  /** Methods the kernel protects. Default: ['POST', 'PATCH']. */
  methods?: string[]
  /** Reject requests without a key (400) instead of passing through. Default: false. */
  enforce?: boolean
  /** What the payload fingerprint covers. Default: 'body'. */
  fingerprint?: FingerprintStrategy
  /** Largest response body stored for replay; larger ones are served but never cached. Default: 1 MiB. */
  maxBodyBytes?: number
  /** Response headers stored and replayed verbatim. Default: ['content-type', 'location']. */
  replayHeaders?: string[]
  /** Retry-After hint on 409 responses, in seconds. Default: 1. */
  retryAfterSeconds?: number
}

export type KernelOutcome =
  | { kind: 'passthrough' }
  | { kind: 'handled' }
  | { kind: 'respond', response: CapturedHttpResponse }

const DEFAULT_METHODS = ['POST', 'PATCH']
const DEFAULT_REPLAY_HEADERS = ['content-type', 'location']
const DEFAULT_MAX_BODY_BYTES = 1_048_576

/**
 * Framework-agnostic implementation of the IETF Idempotency-Key draft
 * semantics: faithful status/header/body replay with an
 * `Idempotency-Replayed: true` marker, 409 + Retry-After on concurrent
 * execution, 422 on key reuse with a different payload. Framework adapters
 * only translate their request/response into these calls; response capture
 * is the single framework-specific part.
 */
export class HttpIdempotencyKernel {
  readonly maxBodyBytes: number
  /** Lower-cased header carrying the key; adapters read it to gate work. */
  readonly header: string
  private readonly idempotency: Idempotency
  private readonly methods: Set<string>
  private readonly enforce: boolean
  private readonly fingerprintPayload: (request: HttpRequestFacts) => unknown
  private readonly replayHeaders: string[]
  private readonly retryAfterSeconds: number

  constructor (idempotency: Idempotency, options: HttpKernelOptions = {}) {
    this.idempotency = idempotency
    this.header = (options.header ?? 'Idempotency-Key').toLowerCase()
    this.methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()))
    this.enforce = options.enforce ?? false
    // The strategy normalizes to a function once; the default is the body.
    const fingerprint = options.fingerprint
    this.fingerprintPayload = typeof fingerprint === 'function'
      ? fingerprint
      : fingerprint === 'body-and-path'
        ? (request) => ({ path: request.path, body: request.body ?? null })
        : (request) => request.body
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.replayHeaders = (options.replayHeaders ?? DEFAULT_REPLAY_HEADERS).map((name) => name.toLowerCase())
    this.retryAfterSeconds = options.retryAfterSeconds ?? 1
  }

  shouldHandle (method: string): boolean {
    return this.methods.has(method.toUpperCase())
  }

  /**
   * Whether this request has a body worth reading: only a protected method
   * carrying a key is ever fingerprinted. Adapters that must buffer the
   * request body call this first, so nothing else pays for the buffering:
   * a missing key under `enforce` is answered without reading anything.
   */
  handles (method: string, key: string | undefined): boolean {
    return this.shouldHandle(method) && key !== undefined && key !== ''
  }

  async handle (
    request: HttpRequestFacts,
    runDownstream: () => Promise<CapturedHttpResponse | null>
  ): Promise<KernelOutcome> {
    if (!this.shouldHandle(request.method)) return { kind: 'passthrough' }
    const key = request.header(this.header)
    if (key === undefined || key === '') {
      if (!this.enforce) return { kind: 'passthrough' }
      return {
        kind: 'respond',
        response: this.problem(400, 'IDEMPOTENCY_KEY_REQUIRED', `the ${this.header} header is required on ${request.method.toUpperCase()} requests`)
      }
    }

    const payload = this.fingerprintPayload(request)
    // Once the downstream response is out there is nothing left to answer
    // with: a late failure can only be reported, never mapped to a status.
    let responded = false
    try {
      const outcome = await this.idempotency.executeWithMetadata<CapturedHttpResponse | null>(
        { key, payload },
        async (ctx) => {
          const captured = await runDownstream()
          responded = true
          // Server errors are transient by definition, and bodies that
          // cannot be replayed faithfully must not be cached: the response
          // is served and the record is released without ever holding an
          // outcome, so a client retry re-executes under a fresh lock.
          if (captured === null || captured.status >= 500) ctx.doNotStore()
          return captured
        }
      )
      const stored = outcome.value
      if (!outcome.replayed) return { kind: 'handled' }
      if (stored === null) {
        // Unreachable through this kernel, which never stores a null: only a
        // hand-written record gets here, and it has no response to serve.
        return { kind: 'passthrough' }
      }
      return {
        kind: 'respond',
        response: {
          status: stored.status,
          headers: { ...stored.headers, 'idempotency-replayed': 'true' },
          body: stored.body
        }
      }
    } catch (error) {
      if (responded) {
        // A settlement failure after the client was served (a lock that
        // expired mid-execution, a storage that died on the completion
        // write). Overwriting the delivered response with a 5xx would be a
        // lie, so the failure is reported and the response stands; the
        // record was not stored, so a retry re-executes.
        process.emitWarning(`quayside could not settle the record for "${key}" after the response was sent: ${String(error)}`)
        return { kind: 'handled' }
      }
      if (error instanceof ConcurrentExecutionError || error instanceof WaitTimeoutError) {
        return {
          kind: 'respond',
          response: this.problem(409, error.code, 'another request with this idempotency key is still in progress', {
            'retry-after': String(this.retryAfterSeconds)
          })
        }
      }
      if (error instanceof IdempotencyKeyReuseError) {
        return {
          kind: 'respond',
          response: this.problem(422, error.code, 'this idempotency key was already used with a different payload')
        }
      }
      if (error instanceof QuaysideError) {
        const status = error.code === 'IDEMPOTENCY_STORAGE_UNAVAILABLE' ? 503 : 500
        return { kind: 'respond', response: this.problem(status, error.code, error.message) }
      }
      throw error
    }
  }

  /**
   * The UTF-8 and size gate shared by every adapter's response capture.
   * Returns the replayable body, or null when the response must be served
   * without being cached (oversized or not valid UTF-8).
   */
  cacheableBody (data: string | Uint8Array): string | null {
    // Buffer.byteLength measures strings in UTF-8 bytes and views by their
    // byteLength, so one call covers both input types.
    const size = Buffer.byteLength(data)
    if (size > this.maxBodyBytes) return null
    return this.decodeUtf8(data)
  }

  /**
   * The UTF-8 gate alone, for adapters whose capture already enforced the
   * size cap while buffering. Returns null when the bytes are not valid
   * UTF-8 (string replay would corrupt them).
   */
  decodeUtf8 (data: string | Uint8Array): string | null {
    if (typeof data === 'string') return data
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      return null
    }
  }

  /** Collects the replay-relevant response headers via the adapter's getter. */
  selectHeaders (get: (name: string) => unknown): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of this.replayHeaders) {
      const value = get(name)
      if (typeof value === 'string' && value !== '') headers[name] = value
      else if (typeof value === 'number') headers[name] = String(value)
      else if (Array.isArray(value) && value.length > 0) headers[name] = value.map(String).join(', ')
    }
    return headers
  }

  private problem (
    status: number,
    code: string,
    detail: string,
    extraHeaders: Record<string, string> = {}
  ): CapturedHttpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
      body: JSON.stringify({ error: code, detail })
    }
  }
}
