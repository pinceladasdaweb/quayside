# Writing a framework adapter in an afternoon

Every HTTP adapter is thin glue over the shared kernel
(`src/http/kernel.ts`). The kernel owns *all* protocol semantics — replay,
conflict mapping, fingerprinting, cacheability — so an adapter only has to
answer three questions:

1. How do I read the method, path, headers and parsed body from a request?
2. How do I run the rest of the pipeline and **capture** the response
   (status, headers, body)?
3. How do I write a response the kernel hands me?

The kernel's contract:

```ts
const kernel = new HttpIdempotencyKernel(idempotency, options)

const outcome = await kernel.handle(requestFacts, runDownstream)
// outcome.kind:
//   'passthrough' - run the pipeline normally, no capture
//   'handled'     - the pipeline already ran and responded
//   'respond'     - write outcome.response (replay or mapped error)
```

`runDownstream` runs the rest of the pipeline and resolves with a
`CapturedHttpResponse` — or `null` when the response must be served without
being cached. Four helpers do the heavy lifting: `kernel.cacheableBody(data)`
applies the UTF-8 and `maxBodyBytes` gates, `kernel.selectHeaders(get)`
collects the replay-relevant headers, `kernel.handles(method, key)`
answers whether this request gets anything but a pass-through — adapters
that must buffer the request body to fingerprint it call it first, so an
unprotected method or a keyless request never pays for the read — and
`kernel.keyFor(facts)` derives the key through whatever the application
configured, which is what a pre-gate must use so it cannot disagree with
`handle()`. Check `kernel.shouldHandle(method)` before deriving: a custom
extractor may assume protected-route context and must not run for methods
the kernel ignores.

Two obligations on the facts you build:

- **`header(name)` must be case-insensitive.** Node lowercases incoming
  header keys, so a raw `req.headers[name]` lookup silently returns
  `undefined` for `header('Idempotency-Key')` — the conventional spelling
  an application's custom key or fingerprint extractor will use, and an
  undefined key means unprotected passthrough with no signal. Lower the
  name yourself (`req.headers[name.toLowerCase()]`) unless your framework
  already normalizes.
- **`raw` carries your framework's native request.** Key and fingerprint
  extractors cast it to reach state the facts cannot describe — the
  authenticated principal an auth middleware attached, most of all. Pass it
  and applications can scope keys per caller on your adapter; omit it and
  they cannot.

## Worked example: Koa

Koa middleware wraps `await next()`, which makes it the easiest shape — the
same pattern the Hono adapter uses:

```ts
import { HttpIdempotencyKernel } from '../http/kernel'
import type { HttpKernelOptions } from '../http/kernel'
import type { Idempotency } from '../index'

export function KoaMiddleware (idempotency: Idempotency, options: HttpKernelOptions = {}) {
  const kernel = new HttpIdempotencyKernel(idempotency, options)
  return async function quaysideIdempotency (ctx, next) {
    const outcome = await kernel.handle(
      {
        method: ctx.method,
        path: ctx.path,
        body: ctx.request.body,
        // ctx.get is already case-insensitive; a raw headers object is not.
        header: (name) => ctx.get(name) || undefined,
        raw: ctx
      },
      async () => {
        await next()
        const body = typeof ctx.body === 'string' || ctx.body instanceof Uint8Array
          ? kernel.cacheableBody(ctx.body)
          : ctx.body === null || ctx.body === undefined
            ? ''
            : kernel.cacheableBody(JSON.stringify(ctx.body))
        if (body === null) return null // binary or oversized: serve, never cache
        return {
          status: ctx.status,
          headers: kernel.selectHeaders((name) => ctx.response.get(name) || undefined),
          body
        }
      }
    )
    if (outcome.kind === 'passthrough') {
      await next()
    } else if (outcome.kind === 'respond') {
      ctx.status = outcome.response.status
      for (const [name, value] of Object.entries(outcome.response.headers)) ctx.set(name, value)
      ctx.body = outcome.response.body
    }
    // 'handled': the downstream middleware already produced the response.
  }
}
```

That is the entire adapter. The 409/422/400 mapping, the replay marker, the
fingerprint comparison and the 5xx/binary/oversized rules all come from the
kernel and behave identically to the shipped adapters.

## Checklist for a new adapter

- [ ] Entry point at `src/<framework>/index.ts`, exported through a new
  `entry(...)` pair in `rollup.config.mjs` with `{ core: true }` and the
  matching `exports`/`typesVersions` blocks in `package.json`
- [ ] Framework types declared structurally — no runtime or type dependency
  on the framework package in `src/`
- [ ] Tests against the real framework (dev dependency), covering at
  minimum: replay with status + headers + marker, 422 on payload change,
  passthrough without a key, binary/oversized never cached, handler errors
  re-execute, and a mixed-case `header()` lookup finding its value
- [ ] `raw` populated with the native request, so applications can scope
  keys to the authenticated principal (docs/http.md)
- [ ] Frameworks whose pipeline cannot be wrapped in one function (hook
  models like Fastify) can bridge the kernel's continuation with a deferred:
  see `src/fastify/index.ts`
- [ ] If you settle that deferred from a lifecycle event rather than from
  the response hook, settle it **only for a response that finished**. A
  connection that dies mid-handler says nothing about the handler, which
  keeps running — resolving there releases the record while the work is
  still in flight, and the client's next retry executes it a second time.
  Leaving the record locked costs a bounded `lockTtl` of 409s; releasing it
  early costs the guarantee
