# NestJS

`quayside/nestjs` ships a dynamic module, an interceptor and an
`@Idempotent()` decorator. Peer dependencies: `@nestjs/common` and `rxjs` —
both already present in any NestJS application.

## Setup

```ts
import { Module } from '@nestjs/common'
import { QuaysideModule } from 'quayside/nestjs'
import { RedisStorage } from 'quayside/redis'

@Module({
  imports: [
    QuaysideModule.forRoot({
      storage: new RedisStorage(redis),
      resultTtl: '24h',
      lockTtl: '30s'
      // header: 'Idempotency-Key' (default)
    })
  ]
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` is available when the
options depend on other providers (a config service, a connection pool).
The module registers globally by default (`global: false` opts out) and
exports the `Idempotency` instance under the `QUAYSIDE_IDEMPOTENCY` token —
inject it anywhere for raw `execute()` calls outside HTTP.

## Protecting handlers

```ts
import { Controller, Post, UseInterceptors } from '@nestjs/common'
import { Idempotent, IdempotencyInterceptor } from 'quayside/nestjs'

@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
export class PaymentsController {
  @Post()
  @Idempotent()
  create (@Body() body: CreatePaymentDto) {
    return this.payments.create(body)
  }

  @Post('refunds')
  @Idempotent({
    key: (request) => (request.body as RefundDto).refundId, // instead of the header
    ttl: '1h',            // per-route replay window
    enforce: true         // 400 when no key is present
  })
  refund () { ... }
}
```

To protect every controller without repeating `@UseInterceptors`, bind it
globally in the application module:

```ts
import { APP_INTERCEPTOR } from '@nestjs/core'

providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }]
```

Only handlers marked with `@Idempotent()` participate — the interceptor is a
no-op everywhere else.

## Semantics

The interceptor wraps the handler's *return value* (what Nest serializes),
so replays go through the route's own status code and headers — a `201`
route replays as `201`. Replays add `Idempotency-Replayed: true`. Errors map
to Nest `HttpException`s:

| Situation | Response |
|---|---|
| Same key, execution still running | `409` + `Retry-After` |
| Same key, different payload | `422` |
| Missing key with `enforce: true` | `400` |
| Key longer than `maxKeyLength` | `400` |
| Storage unreachable (fail-closed) | `503` |

Decorator options: `key` (extractor over the request; default is the
configured header), `fingerprint` (function over the request or `false`;
default is the request body), `ttl` (per-route `resultTtl` override) and
`enforce`.

On endpoints serving more than one caller, use the `key` extractor to scope
records to the authenticated principal — a bare header key is shared by
every caller on the same storage, and replay happens before the route's own
authorization runs. The request object is what your guards decorated, so
`request.user` is reachable by casting; the pattern and its rationale live
in [docs/http.md](http.md#scope-keys-to-the-caller).

Handler exceptions are not cached: a failed request can always be retried.
With `persistFailures` configured, what persists follows the exception's
own declaration:

| The handler throws | Under `persistFailures` |
|---|---|
| `HttpException` with a 4xx status | Persisted and replayed: the status declares a deterministic client failure, and a retry of the same key answers exactly what the first attempt answered |
| `HttpException` with a 5xx status | Never persisted: a declared server error is transient by definition, so the retry re-executes under a fresh lock (the same rule the HTTP kernel applies to 5xx responses) |
| A plain `Error` | Persisted and replayed: it declares nothing, so the flag you opted into is the ruling intent — `persistFailures` means failures in your domain are deterministic |

Two more rules mirror the HTTP kernel at the value level. A handler that
*returns* after declaring a server status on the passthrough response
(`@Res({ passthrough: true })` + `res.status(503)`) is answering with a
transient error: the value is served but never persisted, so the retry
re-executes. And when the record cannot be settled *after* the handler
succeeded (a lock that outlived a slow execution, a storage that died on
the completion write), the computed value is still served — answering 500
would discard completed work — with the failure reported as a process
warning; nothing was stored, so a retry re-executes.

The practical advice hiding in that table: give business failures their
status. A declined card thrown as `new HttpException(..., 402)` gets
deterministic replay *and* tells the client the truth; thrown as a plain
`Error` it still replays, but reaches the client as a `500`. And if a
plain-error failure was in fact transient (a bug since fixed, a dead
dependency), `invalidate(key)` clears the stored record without waiting
out the result TTL.

Works on both the Express and the Fastify platform adapters.

A complete runnable application lives in
[examples/nestjs.ts](../examples/nestjs.ts).
