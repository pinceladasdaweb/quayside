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
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > kernel.maxBodyBytes) return null

  const reader = response.clone().body
  if (reader === null) return null
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
  const body = kernel.cacheableBody(Buffer.concat(chunks))
  return body === null ? null : { status: response.status, headers, body }
}

export function HonoMiddleware (
  idempotency: Idempotency,
  options: HttpKernelOptions = {}
): (c: HonoContextLike, next: HonoNext) => Promise<Response | undefined> {
  const kernel = new HttpIdempotencyKernel(idempotency, options)
  return async function quaysideIdempotency (c, next) {
    if (!kernel.shouldHandle(c.req.method)) {
      await next()
      return
    }
    const body = await requestBody(c.req.raw)
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
      return new Response(outcome.response.body, {
        status: outcome.response.status,
        headers: outcome.response.headers
      })
    }
    // 'handled': the downstream response is already on c.res.
  }
}
