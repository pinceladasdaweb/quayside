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
  missing key under `enforce`.
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
| `methods` | `['POST', 'PATCH']` | Methods the adapter protects |
| `enforce` | `false` | `true` rejects requests without a key (400); `false` passes them through unprotected |
| `fingerprint` | `'body'` | `'body'`, `'body-and-path'` or a custom `(request) => unknown` |
| `maxBodyBytes` | 1 MiB | Largest response body stored for replay |
| `replayHeaders` | `['content-type', 'location']` | Response headers stored and replayed |
| `retryAfterSeconds` | `1` | `Retry-After` hint on 409 responses |

## What is cached — and what deliberately is not

A response is stored for replay only when it is **UTF-8 text**, **within
`maxBodyBytes`** and **below status 500**:

- Binary bodies (images, gzip) are served untouched but never cached —
  string replay would corrupt them.
- Oversized bodies stream through uncached, so a bulk-export endpoint cannot
  exhaust the store.
- 5xx responses are served but never cached: server errors are transient by
  definition, and a client retry re-executes the handler.

In all three cases the idempotency record is released, so the endpoint keeps
its concurrency protection on every attempt while storing nothing.

Note that with the Express adapter the record is committed right after the
response is flushed; with Fastify and Hono it is committed before the
response leaves the server.
