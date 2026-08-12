import type { Idempotency } from '../index'
import { HttpIdempotencyKernel } from '../http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions, KernelOutcome } from '../http/kernel'

export type { CapturedHttpResponse, FingerprintStrategy, HttpKernelOptions, HttpRequestFacts } from '../http/kernel'

// Structural on purpose: any Fastify 4/5 instance satisfies these, with no
// dependency on fastify types.
export interface FastifyRequestLike {
  method: string
  url: string
  headers: Record<string, unknown>
  body?: unknown
}

export interface FastifyReplyLike {
  statusCode: number
  getHeader (name: string): unknown
  header (name: string, value: string): unknown
  code (status: number): unknown
  send (payload: unknown): unknown
}

export interface FastifyInstanceLike {
  addHook (name: 'preHandler', hook: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>): unknown
  addHook (name: 'onSend', hook: (request: FastifyRequestLike, reply: FastifyReplyLike, payload: unknown) => Promise<unknown>): unknown
}

interface PendingExecution {
  resolveCapture (captured: CapturedHttpResponse | null): void
  outcome: Promise<KernelOutcome>
  settled: boolean
}

function headerValue (value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function pathOf (url: string): string {
  const queryStart = url.indexOf('?')
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

function capturedFrom (
  kernel: HttpIdempotencyKernel,
  reply: FastifyReplyLike,
  payload: unknown
): CapturedHttpResponse | null {
  let body: string | null
  if (payload === undefined || payload === null) body = ''
  else if (typeof payload === 'string' || payload instanceof Uint8Array) body = kernel.cacheableBody(payload)
  else return null // streams and anything else pass through uncached
  if (body === null) return null
  return {
    status: reply.statusCode,
    headers: kernel.selectHeaders((name) => reply.getHeader(name)),
    body
  }
}

export function FastifyPlugin (
  idempotency: Idempotency,
  options: HttpKernelOptions = {}
): (instance: FastifyInstanceLike) => Promise<void> {
  const kernel = new HttpIdempotencyKernel(idempotency, options)
  const pending = new WeakMap<object, PendingExecution>()

  const plugin = async function quaysideIdempotency (instance: FastifyInstanceLike): Promise<void> {
    // Fastify hooks are lifecycle events, not a wrapping function, so the
    // kernel's continuation is bridged: preHandler starts handle() and
    // returns as soon as the kernel either decides the outcome (replay,
    // conflict, passthrough) or acquires the lock and asks for the
    // downstream response, which onSend later provides.
    instance.addHook('preHandler', async (request, reply) => {
      let proceed: () => void = () => {}
      const proceeded = new Promise<'execute'>((resolve) => {
        proceed = () => resolve('execute')
      })
      let resolveCapture: (captured: CapturedHttpResponse | null) => void = () => {}
      const capture = new Promise<CapturedHttpResponse | null>((resolve) => {
        resolveCapture = resolve
      })

      const outcome = kernel.handle(
        {
          method: request.method,
          path: pathOf(request.url),
          body: request.body,
          header: (name) => headerValue(request.headers[name])
        },
        () => {
          proceed()
          return capture
        }
      )
      outcome.catch(() => {}) // observed again in onSend

      const first = await Promise.race([proceeded, outcome])
      if (first === 'execute') {
        pending.set(request as object, { resolveCapture, outcome, settled: false })
        return
      }
      if (first.kind === 'respond') {
        reply.code(first.response.status)
        for (const [name, value] of Object.entries(first.response.headers)) reply.header(name, value)
        await reply.send(first.response.body)
      }
      // 'passthrough': continue down the chain unprotected.
    })

    instance.addHook('onSend', async (request, reply, payload) => {
      const entry = pending.get(request as object)
      if (entry === undefined || entry.settled) return payload
      entry.settled = true
      pending.delete(request as object)
      entry.resolveCapture(capturedFrom(kernel, reply, payload))
      try {
        // The record is committed before the response leaves the server.
        await entry.outcome
      } catch {
        // The record was released; the response still goes out.
      }
      return payload
    })
  }

  // The zero-dependency equivalent of fastify-plugin: without it the hooks
  // would be encapsulated inside the plugin scope and never see the
  // application's routes.
  ;(plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true
  return plugin
}
