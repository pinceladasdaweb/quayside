import type { Idempotency } from '../index'
import { HttpIdempotencyKernel, headerValue } from '../http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions } from '../http/kernel'

export type { CapturedHttpResponse, FingerprintStrategy, HttpKernelOptions, HttpRequestFacts } from '../http/kernel'

// Structural on purpose: any Express 4/5 request/response satisfies these,
// with no dependency on @types/express.
export interface ExpressRequestLike {
  method: string
  path: string
  headers: Record<string, unknown>
  body?: unknown
}

export interface ExpressResponseLike {
  statusCode: number
  setHeader (name: string, value: string): unknown
  getHeader (name: string): unknown
  write: (...args: unknown[]) => boolean
  end: (...args: unknown[]) => unknown
}

export type ExpressNext = (error?: unknown) => void

// Response capture is the framework-specific part: Express writes through
// res.write/res.end (res.send and res.json funnel into them), so both are
// intercepted while the rest of the chain runs.
function captureResponse (
  kernel: HttpIdempotencyKernel,
  res: ExpressResponseLike,
  next: ExpressNext
): Promise<CapturedHttpResponse | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)

    const record = (chunk: unknown, encoding: unknown): void => {
      if (overflow || chunk === undefined || chunk === null || typeof chunk === 'function') return
      // Buffer.from ignores the encoding argument for Buffer and typed-array
      // chunks and falls back to utf8 when a string chunk arrives with a
      // non-string encoding slot (a callback), so one call covers every
      // write/end signature.
      const buffer = Buffer.from(chunk as string, encoding as BufferEncoding)
      size += buffer.byteLength
      if (size > kernel.maxBodyBytes) {
        overflow = true
        return
      }
      chunks.push(buffer)
    }

    res.write = function (chunk: unknown, ...args: unknown[]) {
      record(chunk, args[0])
      return originalWrite(chunk, ...args)
    }
    res.end = function (chunk?: unknown, ...args: unknown[]) {
      record(chunk, args[0])
      const result = originalEnd(chunk, ...args)
      res.write = originalWrite
      res.end = originalEnd
      if (overflow) {
        resolve(null)
        return result
      }
      // record() is the size authority here; only the UTF-8 gate remains.
      const body = kernel.decodeUtf8(Buffer.concat(chunks))
      resolve(body === null
        ? null
        : {
            status: res.statusCode,
            headers: kernel.selectHeaders((name) => res.getHeader(name)),
            body
          })
      return result
    }
    next()
  })
}

function sendResponse (res: ExpressResponseLike, response: CapturedHttpResponse): void {
  res.statusCode = response.status
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value)
  res.end(response.body)
}

export function ExpressMiddleware (
  idempotency: Idempotency,
  options: HttpKernelOptions = {}
): (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNext) => void {
  const kernel = new HttpIdempotencyKernel(idempotency, options)
  return function quaysideIdempotency (req, res, next) {
    kernel.handle(
      {
        method: req.method,
        path: req.path,
        body: req.body,
        header: (name) => headerValue(req.headers[name])
      },
      () => captureResponse(kernel, res, next)
    ).then((outcome) => {
      if (outcome.kind === 'passthrough') next()
      else if (outcome.kind === 'respond') sendResponse(res, outcome.response)
      // 'handled': the downstream chain already responded.
    }).catch((error: unknown) => {
      next(error)
    })
  }
}
