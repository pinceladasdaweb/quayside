# HTTP adapters

The core already works in any framework without adapters — `execute()` inside
a route handler is fully supported. Adapters exist for *protocol* semantics
only, implementing the IETF `Idempotency-Key` draft:

- **Faithful replay**: the original status code, selected headers and body
  are stored and served on replay, with `Idempotency-Replayed: true` added.
  A `201` + `Location` replays as `201` + `Location`, never a generic `200`.
- **Error mapping**: `409` + `Retry-After` while the first request is still
  running (or when a wait times out), `422` when the same key arrives with a
  different payload, `503` when the storage is unreachable, `400` for a
  missing key under `enforce` or a key that breaks `maxKeyLength` (both are
  client input, so neither is ever answered with a 5xx).
- **Route policies**: which methods to protect, enforce-vs-passthrough,
  fingerprint strategy.

## Usage

```ts
import { Idempotency } from 'quayside'
import { RedisStorage } from 'quayside/redis'

const idempotency = new Idempotency({ storage: new RedisStorage(redis) })
```

Express:

```ts
import { ExpressMiddleware } from 'quayside/express'

app.use(express.json())
app.use(ExpressMiddleware(idempotency, { enforce: true }))
```

Fastify:

```ts
import { FastifyPlugin } from 'quayside/fastify'

await app.register(FastifyPlugin(idempotency, { enforce: true }))
```

Hono:

```ts
import { HonoMiddleware } from 'quayside/hono'

app.use(HonoMiddleware(idempotency, { enforce: true }))
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `header` | `'Idempotency-Key'` | Header carrying the key |
| `key` | header read | Derives the storage key from the request; `undefined` means no key. See [Scope keys to the caller](#scope-keys-to-the-caller) |
| `methods` | `['POST', 'PATCH']` | Methods the adapter protects |
| `enforce` | `false` | `true` rejects requests without a key (400); `false` passes them through unprotected |
| `fingerprint` | `'body'` | `'body'`, `'body-and-path'` or a custom `(request) => unknown` |
| `maxBodyBytes` | 1 MiB | Largest response body stored for replay |
| `replayHeaders` | `['content-type', 'location']` | Response headers stored and replayed |
| `retryAfterSeconds` | `1` | `Retry-After` hint on 409 responses |

## Scope keys to the caller

A bare header key is **shared by every caller** on the same storage and
namespace: whoever presents `Idempotency-Key: abc123` first owns the record,
and anyone presenting it later gets the stored response — *before* the route
handler and whatever authorization lives inside it ever run. With predictable
keys (order ids, sequential values, ids leaked into logs or support tickets)
that is a real risk on shared endpoints: another authenticated user replaying
a victim's response, or planting a key first so the victim's own request
fails with `422`.

The `key` option closes this: derive the storage key from the caller's
identity plus the header, and the same header value stops colliding across
principals. The request facts carry the adapter's native request as `raw`
(the Express `req`, the Fastify request, the Hono context), so whatever your
auth middleware attached is in reach:

```ts
app.use(ExpressMiddleware(idempotency, {
  key: (request) => {
    const key = request.header('idempotency-key')
    const user = (request.raw as { user?: { id: string } }).user?.id
    if (key === undefined || user === undefined) return undefined
    // Encode the principal so an id containing ':' cannot alias another
    // caller's composition ('u:1' + 'x' versus 'u' + '1:x').
    return `${encodeURIComponent(user)}:${key}`
  }
}))
```

Returning `undefined` means "this request carries no key": it passes through
unprotected, or answers `400` under `enforce` — so an unauthenticated request
never shares records with anyone. The extractor must not read `body`: the
Hono adapter derives the key before buffering the request, precisely so
keyless requests never pay for a body nobody will fingerprint.

On NestJS the same pattern goes through the decorator's own hook:
`@Idempotent({ key: (request) => ... })` receives the request object, and an
auth guard's `request.user` is reachable by casting. Scope keys per principal
whenever an endpoint serves more than one caller; leave the plain header read
for single-tenant or internal services where every caller is equally trusted.

## What is cached — and what deliberately is not

A response is stored for replay only when it is **UTF-8 text**, **within
`maxBodyBytes`** and **below status 500**:

- Binary bodies (images, gzip) are served untouched but never cached —
  string replay would corrupt them.
- Oversized bodies stream through uncached, so a bulk-export endpoint cannot
  exhaust the store.
- 5xx responses are served but never cached: server errors are transient by
  definition, and a client retry re-executes the handler.

In all three cases the adapter calls `ctx.doNotStore()`, so the record is
released without ever holding an outcome: the endpoint keeps its concurrency
protection on every attempt (a second request racing the first still gets a
409, or waits for it under `onConflict: 'wait'`) while nothing is ever
written for anyone to replay — not even with `persistFailures` enabled.

A failure that happens *after* the response was already sent — a lock that
expired mid-execution, a storage that died on the completion write — cannot
be answered with a different status without lying to the client. The response
stands, the failure is reported as a process warning and through the
`failed` event, and nothing was stored, so a client retry re-executes.

Note that with the Express adapter the record is committed right after the
response is flushed; with Fastify and Hono it is committed before the
response leaves the server.

The Fastify adapter also settles on the raw `close` event, so a hijacked
reply (`reply.hijack()`, SSE, proxying) releases the key instead of holding
it until the lock expires. A connection that dies *before* the response
finished is deliberately not settled that way: Node does not cancel the
handler, so the work is still running, and releasing the key would let the
client's next retry execute it a second time. Those keep the lock until
`lockTtl` — the same treatment as an execution whose process died — and the
handler's late completion still stores its outcome for the retry to replay.
