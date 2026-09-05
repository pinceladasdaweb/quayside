// Runtime imports come from '../index' on purpose: see the note above the
// storage exports in src/index.ts.
import { ERROR_CODES, QuaysideError } from '../index'
import type { Idempotency, QuaysideErrorCode } from '../index'

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

// The request policy's defaults, shared with the NestJS interceptor so the
// two HTTP faces of the library cannot drift apart on them.
export const DEFAULT_HEADER = 'Idempotency-Key'
export const DEFAULT_RETRY_AFTER_SECONDS = 1

/** A key the request can execute under: present and not the empty string. */
export function hasKey (key: string | undefined): key is string {
  return key !== undefined && key !== ''
}

/**
 * Whether a response status declares a server error. Server errors are
 * transient by definition and must never persist as a replayable outcome;
 * this is the one predicate behind that rule, at the kernel (a captured
 * status) and at the NestJS value level (a platform response's statusCode,
 * an HttpException's status). Number() rather than a type guard: a status
 * that reads as 5xx is a server error however the platform spells it, and
 * an absent one is NaN, which compares false.
 */
export function isServerError (status: unknown): boolean {
  return Number(status) >= 500
}

/**
 * The warning for a settlement that failed after the response was already
 * served (a lock that outlived a slow execution, a storage that died on the
 * completion write). The response stands: overwriting it would be a lie,
 * and since nothing was stored a retry re-executes.
 */
export function settlementWarning (key: string, error: unknown): string {
  return `quayside could not settle the record for "${key}" after the response was served: ${String(error)}`
}

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

// One row per error code, and `satisfies` makes the table total: a new
// code cannot compile without deciding what clients are told. A row with a
// fixed message hides an internal detail behind client-facing wording; a
// row without one passes the error's own message through, because it
// names the client's mistake (an invalid key) or a condition the operator
// needs verbatim.
const IN_PROGRESS = { status: 409, retryAfter: true, message: 'another request with this idempotency key is still in progress' }
const HTTP_ERROR_POLICY = {
  [ERROR_CODES.inProgress]: IN_PROGRESS,
  [ERROR_CODES.waitTimeout]: IN_PROGRESS,
  [ERROR_CODES.keyReuse]: { status: 422, retryAfter: false, message: 'this idempotency key was already used with a different payload' },
  // The offending value came from the request, so this is a client error:
  // answering 5xx would blame the server and page someone.
  [ERROR_CODES.keyInvalid]: { status: 400, retryAfter: false },
  [ERROR_CODES.fencing]: { status: 500, retryAfter: false },
  [ERROR_CODES.serialization]: { status: 500, retryAfter: false },
  [ERROR_CODES.storageCorrupt]: { status: 500, retryAfter: false },
  [ERROR_CODES.storageUnavailable]: { status: 503, retryAfter: false }
} as const satisfies Record<QuaysideErrorCode, { status: number, retryAfter: boolean, message?: string }>

export function httpErrorFacts (error: unknown): HttpErrorFacts | null {
  if (!(error instanceof QuaysideError)) return null
  const policy: { status: number, retryAfter: boolean, message?: string } = HTTP_ERROR_POLICY[error.code]
  return { status: policy.status, code: error.code, message: policy.message ?? error.message, retryAfter: policy.retryAfter }
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
  private readonly fingerprintReadsBody: boolean
  private readonly keyOf: (request: HttpRequestFacts) => string | undefined
  private readonly derivesKey: boolean
  private readonly replayHeaders: string[]
  private readonly retryAfterSeconds: number
  private warnedUnparsedBody = false

  constructor (idempotency: Idempotency, options: HttpKernelOptions = {}) {
    this.idempotency = idempotency
    this.header = (options.header ?? DEFAULT_HEADER).toLowerCase()
    this.methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()))
    this.enforce = options.enforce ?? false
    // The strategy normalizes to a function once; the default is the body.
    const fingerprint = options.fingerprint
    this.fingerprintPayload = typeof fingerprint === 'function'
      ? fingerprint
      : fingerprint === 'body-and-path'
        ? (request) => ({ path: request.path, body: request.body ?? null })
        : (request) => request.body
    // Only the built-in strategies read the body; a custom extractor may
    // fingerprint headers or framework state and validate reuse fine with
    // no body at all, so the unparsed-body warning must not accuse it.
    this.fingerprintReadsBody = typeof fingerprint !== 'function'
    this.derivesKey = options.key !== undefined
    this.keyOf = options.key ?? ((request) => request.header(this.header))
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.replayHeaders = (options.replayHeaders ?? DEFAULT_REPLAY_HEADERS).map((name) => name.toLowerCase())
    this.retryAfterSeconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS
  }

  shouldHandle (method: string): boolean {
    return this.methods.has(method.toUpperCase())
  }

  /**
   * Whether this request has a body worth reading: only a protected method
   * carrying a key is ever fingerprinted. Adapters that must buffer the
   * request body call this first, so nothing else pays for the buffering:
   * a missing key under `enforce` is answered without reading anything.
   * The method is checked before the key is derived, so a custom extractor
   * never runs for a method the kernel ignores (a GET on a public route
   * must not be able to crash an extractor that assumes protected-route
   * context). The facts carry no body yet at this point, which is why
   * extractors must not read it; handle() derives the key again on the
   * full facts, so extractors must also be cheap and pure.
   */
  handles (request: HttpRequestFacts): boolean {
    return this.shouldHandle(request.method) && hasKey(this.keyOf(request))
  }

  async handle (
    request: HttpRequestFacts,
    runDownstream: () => Promise<CapturedHttpResponse | null>
  ): Promise<KernelOutcome> {
    if (!this.shouldHandle(request.method)) return { kind: 'passthrough' }
    const key = this.keyOf(request)
    if (!hasKey(key)) {
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
    // it is reported once per kernel - but only when the configured
    // strategy actually reads the body, or the accusation is false.
    if (this.fingerprintReadsBody && !this.warnedUnparsedBody && this.bodyWentMissing(request)) {
      this.warnedUnparsedBody = true
      const received = request.body === undefined
        ? 'undefined'
        : Array.isArray(request.body) ? 'an empty array' : 'an empty object'
      process.emitWarning(`quayside: a ${request.method.toUpperCase()} request carrying "${this.header}" declares a body that did not survive parsing (received ${received}), so the payload fingerprint cannot validate key reuse. Is a body parser mounted before the idempotency middleware, and does it handle this content type?`)
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
          if (captured === null || isServerError(captured.status)) ctx.doNotStore()
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
        process.emitWarning(settlementWarning(key, error))
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
