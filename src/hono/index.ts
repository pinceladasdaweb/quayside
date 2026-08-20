import type { Idempotency } from '../index'
import { HttpIdempotencyKernel } from '../http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions, KernelOutcome } from '../http/kernel'

export type { CapturedHttpResponse, FingerprintStrategy, HttpKernelOptions, HttpRequestFacts } from '../http/kernel'

// Structural on purpose: any Hono 4 context satisfies this, with no
// dependency on hono types.
export interface HonoContextLike {
  req: {
    method: string
    path: string
    raw: Request
    header (name: string): string | undefined
  }
  res: Response
}

export type HonoNext = () => Promise<void>

async function requestBody (request: Request): Promise<string | undefined> {
  const text = await request.clone().text()
  // A bodyless request must fingerprint as absent, not as the empty
  // string, so it stays interchangeable with non-HTTP callers of the same
  // key that pass no payload.
  return text === '' ? undefined : text
}

// Response capture is the framework-specific part: the web Response body is
// a stream, so a clone is read up to the size cap while the original stays
// untouched for the client.
async function captureWebResponse (
  kernel: HttpIdempotencyKernel,
  response: Response
): Promise<CapturedHttpResponse | null> {
  const headers = kernel.selectHeaders((name) => response.headers.get(name))
  if (response.body === null) {
    return { status: response.status, headers, body: '' }
  }
  // Number(null) is 0 and a garbage header is NaN: both fall through to the
  // stream read below, the real size authority.
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > kernel.maxBodyBytes) return null

  // The clone of a response whose body was checked non-null above is never
  // null; the cast removes a branch no test could ever reach.
  const reader = response.clone().body as ReadableStream<Uint8Array>
  const chunks: Uint8Array[] = []
  let size = 0
  const stream = reader.getReader()
  while (true) {
    const { done, value } = await stream.read()
    if (done) break
    size += value.byteLength
    if (size > kernel.maxBodyBytes) {
      await stream.cancel()
      return null
    }
    chunks.push(value)
  }
  // The read loop is the size authority here; only the UTF-8 gate remains.
  const body = kernel.decodeUtf8(Buffer.concat(chunks))
  return body === null ? null : { status: response.status, headers, body }
}

export function HonoMiddleware (
  idempotency: Idempotency,
  options: HttpKernelOptions = {}
): (c: HonoContextLike, next: HonoNext) => Promise<Response | undefined> {
  const kernel = new HttpIdempotencyKernel(idempotency, options)
  return async function quaysideIdempotency (c, next) {
    // The facts are built before the body is read, so the key extractor
    // (which must not depend on the body) can gate the buffering below.
    const facts = {
      method: c.req.method,
      path: c.req.path,
      body: undefined as unknown,
      header: (name: string) => c.req.header(name),
      raw: c
    }
    // Fingerprinting is the only reason to read the body, and reading it
    // clones and buffers the whole request: requests the kernel would only
    // wave through never pay for it. The method gate comes first so the
    // key extractor never runs for a method the kernel ignores: handle()
    // checks the method before deriving the key, and a GET on a public
    // route must not be able to crash an extractor that assumes
    // protected-route context.
    if (kernel.shouldHandle(c.req.method) && kernel.handles(c.req.method, kernel.keyFor(facts))) {
      facts.body = await requestBody(c.req.raw)
    }
    // Hono only dispatches c.res after the middleware chain returns, so
    // awaiting the whole kernel outcome would hold every streamed byte
    // hostage until the source ended or hit the size cap: an SSE client
    // would see nothing at all. The race lets the middleware return the
    // moment downstream produced its response; the capture drains a clone
    // (taken synchronously, before dispatch reads the original) and the
    // record settles concurrently with the body leaving the server. The
    // race also gives the floating outcome its rejection handler.
    let proceed!: () => void
    const proceeded = new Promise<KernelOutcome>((resolve) => {
      proceed = () => resolve({ kind: 'handled' })
    })
    const outcome = kernel.handle(facts, async () => {
      await next()
      proceed()
      return captureWebResponse(kernel, c.res)
    })
    const first = await Promise.race([proceeded, outcome])
    if (first.kind === 'handled') {
      // Downstream answered on c.res; returning lets it flow. A retry
      // arriving before the concurrent settlement finished still sees the
      // in-progress record and gets its 409 (or waits), exactly as it
      // would have mid-execution. (The kernel's own 'handled' cannot win
      // the race: a running executor resolves it first.)
      return
    }
    if (first.kind === 'passthrough') {
      await next()
      return
    }
    // Only 'respond' remains: a replay, a conflict, an enforce rejection or
    // a mapped error. Null-body statuses (204, 304) reject any body, even
    // an empty string; an empty replay body is a no-body response.
    return new Response(first.response.body === '' ? null : first.response.body, {
      status: first.response.status,
      headers: first.response.headers
    })
  }
}
