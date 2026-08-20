// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold against errors thrown by the
// user's Idempotency instance, so the build maps '../index' onto the shipped
// core bundle instead of inlining a private copy.
import {
  ConcurrentExecutionError,
  IdempotencyKeyInvalidError,
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
  /**
   * Case-insensitive header lookup: every adapter accepts any casing, so
   * an extractor written as header('Idempotency-Key') reads the same value
   * everywhere. Adapters implementing the facts by hand must honor this.
   */
  header (name: string): string | undefined
  /**
   * The adapter's native request object (the Express req, the Fastify
   * request, the Hono context), for key and fingerprint extractors that
   * need framework state the facts cannot carry, such as the authenticated
   * principal an auth middleware attached. Deliberately unknown: cast to
   * your framework's shape inside the extractor.
   */
  raw?: unknown
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
  /**
   * Derives the storage key from the request, replacing the plain header
   * read. The primary use is scoping keys to the authenticated principal:
   * a bare header key is shared by every caller on the same storage, so
   * whoever presents it first owns the record. Return undefined to treat
   * the request as carrying no key (passthrough, or 400 under `enforce`).
   * Must not depend on `body`: adapters that buffer lazily derive the key
   * before the body is read.
   */
  key? (request: HttpRequestFacts): string | undefined
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

/** Marker added to every replayed response. */
export const REPLAYED_HEADER = 'idempotency-replayed'

/** Stable code for a protected request that carries no usable key. */
export const KEY_REQUIRED_CODE = 'IDEMPOTENCY_KEY_REQUIRED'

/**
 * What to tell a client whose request produced no key. Naming the header
 * is only truthful when the header is what was read: under a custom
 * extractor the missing ingredient may be something else entirely (an
 * authenticated principal, a tenant), and telling that client to send a
 * header it already sent loops it forever.
 */
export function keyRequiredMessage (
  header: string,
  options: { method?: string, derived?: boolean } = {}
): string {
  const scope = options.method === undefined ? '' : ` on ${options.method.toUpperCase()} requests`
  return options.derived === true
    ? `no idempotency key could be derived for this request${scope}`
    : `the ${header} header is required${scope}`
}

/**
 * Normalizes a framework's header slot to the single string the kernel
 * reads: node frameworks surface header values as string, string[] or
 * undefined, and a repeated header reads as its first value.
 */
export function headerValue (value: unknown): string | undefined {
  if (Array.isArray(value)) return headerValue(value[0])
  return typeof value === 'string' ? value : undefined
}

/**
 * The kernel's error policy as data: status, stable code and message for
 * every quayside error an execution can surface, or null for a foreign
 * error the adapter must rethrow untouched. One table serves the kernel's
 * problem responses and the NestJS interceptor's HttpExceptions, so the
 * adapters cannot drift apart on what a client is told.
 */
export interface HttpErrorFacts {
  status: number
  code: string
  message: string
  /** The response should carry a Retry-After hint (in-progress conflicts). */
  retryAfter: boolean
}

export function httpErrorFacts (error: unknown): HttpErrorFacts | null {
  if (error instanceof ConcurrentExecutionError || error instanceof WaitTimeoutError) {
    return { status: 409, code: error.code, message: 'another request with this idempotency key is still in progress', retryAfter: true }
  }
  if (error instanceof IdempotencyKeyReuseError) {
    return { status: 422, code: error.code, message: 'this idempotency key was already used with a different payload', retryAfter: false }
  }
  if (error instanceof IdempotencyKeyInvalidError) {
    // The offending value came from the request, so this is a client
    // error: answering 5xx would blame the server and page someone.
    return { status: 400, code: error.code, message: error.message, retryAfter: false }
  }
  if (error instanceof QuaysideError) {
    const status = error.code === 'IDEMPOTENCY_STORAGE_UNAVAILABLE' ? 503 : 500
    return { status, code: error.code, message: error.message, retryAfter: false }
  }
  return null
}

// A non-streaming decode keeps no state between calls, so one decoder
// serves every response instead of one per captured body.
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })

// The wire size of the shortest body that legitimately parses to an empty
// container: '{}' and '[]' are both two bytes.
const EMPTY_BODY_BYTES = 2

// A parser that declined this request's content type leaves an empty
// container behind. Own enumerable keys are what the fingerprint reads, so
// they are what "empty" means here.
function isEmptyObject (body: unknown): boolean {
  return typeof body === 'object' && body !== null && Object.keys(body).length === 0
}

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
  private readonly keyOf: (request: HttpRequestFacts) => string | undefined
  private readonly derivesKey: boolean
  private readonly replayHeaders: string[]
  private readonly retryAfterSeconds: number
  private warnedUnparsedBody = false

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
    this.derivesKey = options.key !== undefined
    this.keyOf = options.key ?? ((request) => request.header(this.header))
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

  /**
   * The storage key this request executes under: the configured extractor,
   * or the plain header read. Adapters that gate work before calling
   * handle() derive the key here so both paths agree; the facts may carry
   * no body yet at that point, which is why extractors must not read it.
   */
  keyFor (request: HttpRequestFacts): string | undefined {
    return this.keyOf(request)
  }

  async handle (
    request: HttpRequestFacts,
    runDownstream: () => Promise<CapturedHttpResponse | null>
  ): Promise<KernelOutcome> {
    if (!this.shouldHandle(request.method)) return { kind: 'passthrough' }
    const key = this.keyOf(request)
    if (key === undefined || key === '') {
      if (!this.enforce) return { kind: 'passthrough' }
      return {
        kind: 'respond',
        response: this.problem(400, KEY_REQUIRED_CODE, keyRequiredMessage(this.header, { method: request.method, derived: this.derivesKey }))
      }
    }

    // A protected, keyed request whose wire carries a body that nobody
    // parsed cannot be fingerprinted: the reuse guard silently degrades to
    // key-only matching, and two different payloads under one key would
    // replay instead of answering 422. That is a mount-order or parser
    // misconfiguration, and staying quiet about it is the actual bug, so
    // it is reported once per kernel.
    if (!this.warnedUnparsedBody && this.bodyWentMissing(request)) {
      this.warnedUnparsedBody = true
      process.emitWarning(`quayside: a ${request.method.toUpperCase()} request carrying "${this.header}" declares a body that did not survive parsing (received ${request.body === undefined ? 'undefined' : 'an empty object'}), so the payload fingerprint cannot validate key reuse. Is a body parser mounted before the idempotency middleware, and does it handle this content type?`)
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
          headers: { ...stored.headers, [REPLAYED_HEADER]: 'true' },
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
      const facts = httpErrorFacts(error)
      if (facts === null) throw error
      return {
        kind: 'respond',
        response: this.problem(facts.status, facts.code, facts.message,
          facts.retryAfter ? { 'retry-after': String(this.retryAfterSeconds) } : {})
      }
    }
  }

  // Whether the wire says a request body exists: a content-length above
  // zero or any transfer-encoding. A bodyless request has neither, and its
  // absent fingerprint is legitimate (interchangeable with a payload-less
  // core caller of the same key).
  private declaresBody (request: HttpRequestFacts): boolean {
    if (request.header('transfer-encoding') !== undefined) return true
    const declared = request.header('content-length')
    return declared !== undefined && declared !== '' && declared !== '0'
  }

  /**
   * Whether the body the wire announced reached the kernel intact. Two
   * shapes say it did not: `undefined`, when no parser ran at all, and an
   * empty object, which is what a parser leaves behind for a content type
   * it declined (`express.json()` on `text/plain`, on `multipart`). Both
   * fingerprint every payload identically, so the reuse guard is inert.
   *
   * An empty body is only suspicious against a declared length: `{}` and
   * `[]` are two bytes on the wire, so a longer content-length means the
   * content was dropped. Under a chunked encoding there is no length to
   * compare, and a genuinely empty parsed body is indistinguishable from a
   * dropped one, so that combination stays quiet rather than crying wolf.
   */
  private bodyWentMissing (request: HttpRequestFacts): boolean {
    if (request.body === undefined) return this.declaresBody(request)
    if (!isEmptyObject(request.body)) return false
    const declared = Number(request.header('content-length'))
    return declared > EMPTY_BODY_BYTES
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
      return UTF8_STRICT.decode(data)
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
