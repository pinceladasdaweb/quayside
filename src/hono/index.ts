import type { Idempotency } from '../index'
import { HttpIdempotencyKernel } from '../http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions } from '../http/kernel'

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
    // Fingerprinting is the only reason to read the body, and reading it
    // clones and buffers the whole request: requests the kernel would only
    // wave through never pay for it.
    const body = kernel.handles(c.req.method, c.req.header(kernel.header))
      ? await requestBody(c.req.raw)
      : undefined
    const outcome = await kernel.handle(
      {
        method: c.req.method,
        path: c.req.path,
        body,
        header: (name) => c.req.header(name)
      },
      async () => {
        await next()
        return captureWebResponse(kernel, c.res)
      }
    )
    if (outcome.kind === 'passthrough') {
      await next()
      return
    }
    if (outcome.kind === 'respond') {
      // Null-body statuses (204, 304) reject any body, even an empty
      // string; an empty replay body is a no-body response.
      return new Response(outcome.response.body === '' ? null : outcome.response.body, {
        status: outcome.response.status,
        headers: outcome.response.headers
      })
    }
    // 'handled': the downstream response is already on c.res.
  }
}
