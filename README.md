# quayside

> **Generic idempotency for Node.js** — execute any operation exactly once per key, with pluggable storage, explicit concurrency semantics, and first-class observability.

[![CI](https://github.com/pinceladasdaweb/quayside/actions/workflows/ci.yml/badge.svg)](https://github.com/pinceladasdaweb/quayside/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/quayside.svg)](https://www.npmjs.com/package/quayside)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The quay is where cargo lands **once**: unloaded, registered, never processed twice. quayside is that quay for your operations — REST handlers, queue consumers, cron jobs, workers and CLI commands all get the same guarantee: *run this function once per key; if it already ran, return the stored result; if it is running right now, don't run it again.*

```ts
import { Idempotency } from 'quayside'
import { RedisStorage } from 'quayside/redis'

const idempotency = new Idempotency({
  storage: new RedisStorage(redis),
  resultTtl: '24h',   // how long a completed result stays replayable
  lockTtl: '30s'      // how long a crashed execution blocks the key
})

const result = await idempotency.execute('invoice:123', async () => {
  return createPayment()   // runs once; every later call replays the result
})
```

## Table of contents

- [Why another idempotency library?](#why-another-idempotency-library)
- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Storage](#storage)
- [HTTP adapters](#http-adapters)
- [NestJS](#nestjs)
- [Observability](#observability)
- [Errors](#errors)
- [API](#api)
- [Documentation](#documentation)
- [Development](#development)

## Why another idempotency library?

Every company eventually hand-rolls this. Behind the one-liner hide lock acquisition, concurrent execution, replay, TTLs, crash recovery, rollback, result serialization and multi-storage support — and the existing libraries each solve a slice:

| | quayside | [steadykey](https://github.com/ebogdum/steadykey) | [Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/utilities/idempotency/) | [@node-idempotency](https://github.com/mahendraHegde/node-idempotency) | [express-idempotency](https://github.com/villelahdenvuo/express-idempotency) |
|---|---|---|---|---|---|
| **Fencing tokens** — a holder that lost its lock can **never** overwrite the new holder's result | ✅ enforced in-store, race-tested | ❌ README admits the operation may run twice | ➖ | ❌ | ❌ |
| Framework-agnostic core (consumers, jobs, CLI) | ✅ | ✅ | ➖ Lambda-shaped | ➖ HTTP semantics baked in | ❌ Express only |
| State machine with crash recovery (`lockTtl`) | ✅ | ✅ lease, unfenced | ✅ | ➖ partial | ❌ replay only |
| Separate lock TTL vs result TTL | ✅ | ➖ | ✅ | ❌ | ❌ |
| Payload fingerprint (same key + different body ⇒ error) | ✅ constant-time | ➖ payload *is* the key | ✅ | ✅ | ➖ deep-equal, HTTP only |
| Concurrency policy: reject **and** wait | ✅ + storage-assisted wake-up | ➖ poll-only wait | ➖ throws only | ➖ throws only | ❌ |
| Storage: memory / Redis / Postgres / MySQL | ✅ all four, one contract suite | ✅ many, thin contract | ➖ DynamoDB-first | ➖ memory, redis | ➖ plugin-ish |
| HTTP adapters with IETF draft semantics (status/header replay, 409/422) | ✅ Express · Fastify · Hono | ➖ middleware, thinner | n/a | ✅ | ➖ stale |
| NestJS module + `@Idempotent()` decorator | ✅ | ❌ | ✅ (Lambda) | ✅ | ❌ |
| Typed events + pluggable metrics collector | ✅ native, `correlationId` | ➖ onHit/onMiss callbacks | ➖ CloudWatch-shaped | ❌ | ❌ |
| Runtime dependencies | **0** | 0 | several | several | several |

Design principles:

- **The core knows nothing about HTTP.** `execute(key, fn)` is the primitive; HTTP is one adapter among many, and the raw core works in any framework from day 1.
- **Semantics borrowed from the best.** The state machine and payload-fingerprint validation follow AWS Powertools and Stripe — the two implementations that got the hard cases right.
- **Atomicity lives in the storage, never in JavaScript.** Fenced transitions are Lua scripts on Redis and token-conditional statements on SQL; a stale holder's late write *fails*, it never overwrites.
- **Never magic.** Values that cannot be stored faithfully raise errors instead of being silently dropped; keys are rejected instead of truncated; failures degrade loudly.
- **Zero runtime dependencies**, in the core and in every adapter — storage clients and frameworks are bring-your-own, typed structurally.

Every claim above is enforced by the test suite — including a 50-way concurrency race, `SIGKILL` crash recovery and a split-brain fencing test against real Redis, Postgres and MySQL servers (Testcontainers).

## Install

```bash
npm install quayside
```

Works with both module systems:

```ts
import { Idempotency } from 'quayside'          // ESM
const { Idempotency } = require('quayside')     // CJS
```

Requires Node.js >= 22.

## Quick start

```ts
import { Idempotency } from 'quayside'
import { MemoryStorage } from 'quayside/memory'

const idempotency = new Idempotency({ storage: new MemoryStorage() })

// 1. The primitive: execute once per key
const payment = await idempotency.execute('invoice:123', () => createPayment())

// 2. Payload fingerprint: same key + different body => IdempotencyKeyReuseError
await idempotency.execute(
  { key: req.headers['idempotency-key'] as string, payload: req.body },
  () => createPayment(req.body)
)

// 3. No client key? Derive one from the payload (consumers, jobs)
await idempotency.execute(
  { payload: message.value, ignoreFields: ['meta.timestamp', 'requestId'] },
  () => processOrder(message.value)
)

// 4. Decorate once, call everywhere
const createOnce = idempotency.wrap(createPayment, {
  key: (input) => `payment:${input.invoiceId}`
})

// 5. Replay metadata, inspection, invalidation
const { value, replayed, storedAt } = await idempotency.executeWithMetadata('invoice:123', fn)
await idempotency.get('invoice:123')
await idempotency.invalidate('invoice:123')
```

The same `execute` call works verbatim inside an Express route, a Fastify handler, a Hono handler, a Kafka/RabbitMQ consumer, a cron job or a CLI command. **Adapters are protocol sugar, not a requirement.**

## Core concepts

### The atomic write is the lock

```
                    ┌──────────────┐
   execute(key) ──▶ │  IN_PROGRESS │──── fn resolves ────▶ COMPLETED (result stored for resultTtl)
                    │  (lockTtl)   │──── fn rejects ─────▶ record deleted → retry allowed
                    └──────────────┘──── process crash ──▶ lock expires → retry allowed
```

`IN_PROGRESS` is written atomically (create-if-absent) before your function runs — that write *is* the lock; there is no separate locking step. On success the record transitions to `COMPLETED` guarded by a **fencing token**: a holder that lost its lock (GC pause, slow I/O, expired TTL) gets `FencingError` from the store itself and can never overwrite the new holder's result.

### Two TTLs, not one

Conflating these is the single most common bug in homemade implementations:

- **`lockTtl`** (default `30s`) bounds crash recovery: if the process dies mid-flight, the key unblocks when the lock expires. Long-running functions heartbeat with `ctx.extend()`.
- **`resultTtl`** (default `24h`, Stripe's convention) is the replay window for completed results.

### Intent first, content as validation

The explicit key names the *intent* (an `Idempotency-Key` header, an invoice id). The payload fingerprint — a canonical, type-tagged, locale-independent hash — exists to *validate* it: the same key with a different payload fails with `IdempotencyKeyReuseError` instead of silently replaying a result for another request. When no client sends a key (queue consumers, jobs), deriving the key from the payload is an opt-in convenience with `ignoreFields`/`pickFields` for volatile fields.

### Concurrency is a policy

When a call finds the key `IN_PROGRESS`: `onConflict: 'reject'` (default, HTTP-safe) throws `ConcurrentExecutionError` immediately; `'wait'` blocks until the winner finishes and replays its outcome, bounded by `waitTimeout` — ideal for consumers and workers. Waiters poll with exponential backoff, and storages that support notifications (Redis keyspace events) wake them early.

### Failures are not idempotent

A rejection deletes the record; retries run fresh. `persistFailures: true` opts into storing and replaying the error for non-retryable business failures — the replay preserves `name`, `message`, `stack`, own enumerable properties (`code`, `statusCode`, ...) and the `cause` chain, so check `error.code` on replay, not `instanceof`.

### Fail closed, bypass loudly

If the storage is unreachable, `execute` throws `StorageUnavailableError` instead of running without the guarantee. `onStorageError: 'open'` flips the trade-off — the function runs unguarded and every bypass emits a `storage-bypass` event, so degradation is always observable.

### Keys are never truncated

Namespace and key segments are percent-encoded before composition (a client-supplied key cannot impersonate another namespace) and composed keys longer than `maxKeyLength` (default 512) are rejected with `IdempotencyKeyInvalidError` — truncation would silently alias two keys into one record. The value came from the caller, so the HTTP adapters answer `400`, never a 5xx.

Deep dive on all of the above: [docs/core.md](docs/core.md).

## Storage

```ts
import { MemoryStorage } from 'quayside/memory'     // tests and development
import { RedisStorage } from 'quayside/redis'       // SET NX PX + fenced Lua transitions
import { PostgresStorage } from 'quayside/postgres' // ON CONFLICT DO NOTHING + token-conditional updates
import { MysqlStorage } from 'quayside/mysql'       // INSERT IGNORE equivalent
```

Bring your own client — any ioredis instance or `@pinceladasdaweb/redis` RedisClient, any `pg` Pool, any `mysql2/promise` Pool. The SQL adapters ship `CREATE TABLE` migrations (`migrate()` or an exported DDL string) and clean up expired rows lazily — no cron required, with an optional `sweep()` for bulk housekeeping.

Every adapter passes the same storage-contract suite against a real server, including the two invariants that protect correctness: **expired-but-not-purged records read as absent**, and **keys are stored faithfully or rejected — never truncated**. Custom adapters implement one interface and inherit the suite: see [docs/sql.md](docs/sql.md) and [tests/contract](tests/contract/storage-contract.ts).

## HTTP adapters

All HTTP semantics live in one shared kernel implementing the IETF `Idempotency-Key` draft; each adapter is thin glue:

```ts
import { ExpressMiddleware } from 'quayside/express'
import { FastifyPlugin } from 'quayside/fastify'
import { HonoMiddleware } from 'quayside/hono'

app.use(ExpressMiddleware(idempotency, { enforce: true }))
```

- **Faithful replay**: original status + selected headers + body, with `Idempotency-Replayed: true`. A `201` + `Location` replays as `201` + `Location`, never a generic `200`.
- **Error mapping**: `409` + `Retry-After` while the first request runs, `422` on key reuse with a different payload, `503` fail-closed, optional `400` for missing keys.
- **Safe caching**: binary, oversized (`maxBodyBytes`, default 1 MiB) and 5xx responses are served but never stored — and the endpoint keeps its concurrency protection on every attempt.

Options and cacheability rules: [docs/http.md](docs/http.md). Adding another framework is an afternoon of work: [docs/writing-an-adapter.md](docs/writing-an-adapter.md).

## NestJS

```ts
QuaysideModule.forRoot({ storage: new RedisStorage(redis) })

@Post('/payments')
@Idempotent({ ttl: '24h' })
createPayment () { ... }
```

Module (`forRoot`/`forRootAsync`), interceptor and decorator, with per-route key extractors, TTL overrides and `enforce`. Peer dependencies are `@nestjs/common` and `rxjs` only — already present in any Nest application. Full guide: [docs/nestjs.md](docs/nestjs.md).

## Observability

Every execution emits typed events carrying a `correlationId`:

```ts
const idempotency = new Idempotency({
  storage,
  onEvent: (event) => log.debug(event),
  // acquired | replayed | conflict | completed | failed | expired-recovery | storage-bypass
  metrics: {
    onReplayed: (event) => replayCounter.inc(),
    onConflict: (event) => conflictCounter.inc(),
    onStorageBypass: (event) => bypassCounter.inc()  // watch this one
  }
})
```

Listener failures never affect execution semantics — a throwing listener surfaces as a process warning instead of failing the operation or being silently swallowed. Ready-made integrations follow the same shape as [breakwater](https://github.com/pinceladasdaweb/breakwater)'s:

```ts
import { prometheusMetrics } from 'quayside/prometheus' // counters + duration histogram
import { otelSpans } from 'quayside/otel'               // spans with replay/conflict attributes

new Idempotency({ storage, metrics: prometheusMetrics() })
```

Terminal events carry `durationMs` — a replayed duration approximates the time a waiter spent blocked. Details and the PromQL replay-ratio query: [docs/observability.md](docs/observability.md).

## Errors

All errors extend `QuaysideError` and carry a stable `code` — codes are contract, message text is not:

| Error | `code` | HTTP mapping |
|---|---|---|
| `ConcurrentExecutionError` | `IDEMPOTENCY_IN_PROGRESS` | 409 |
| `IdempotencyKeyInvalidError` | `IDEMPOTENCY_KEY_INVALID` | 400 |
| `IdempotencyKeyReuseError` | `IDEMPOTENCY_KEY_REUSE` | 422 |
| `WaitTimeoutError` | `IDEMPOTENCY_WAIT_TIMEOUT` | 409 |
| `FencingError` | `IDEMPOTENCY_FENCING` | 500 |
| `SerializationError` | `IDEMPOTENCY_SERIALIZATION` | 500 |
| `StorageUnavailableError` | `IDEMPOTENCY_STORAGE_UNAVAILABLE` | 503 |

## API

```ts
new Idempotency(options)
```

| Option | Default | Meaning |
|---|---|---|
| `storage` | — (required) | Any `IdempotencyStorage` implementation |
| `resultTtl` | `'24h'` | Replay window for completed results |
| `lockTtl` | `'30s'` | How long an in-progress record survives without completion |
| `onConflict` | `'reject'` | `'reject'` throws immediately; `'wait'` blocks until the winner finishes |
| `waitTimeout` | `'10s'` | Upper bound for `onConflict: 'wait'` |
| `namespace` | — | Key prefix isolating domains that share one storage |
| `maxKeyLength` | `512` | Longest composed storage key; longer keys are rejected |
| `codec` | JSON | Result serialization (`Codec` interface for superjson/msgpack users) |
| `persistFailures` | `false` | Store and replay failures instead of allowing retries |
| `onStorageError` | `'closed'` | `'open'` runs without the guarantee and emits `storage-bypass` |
| `onEvent` / `metrics` | — | Typed event listener / metrics collector |
| `clock` | wall clock | `{ now(), sleep(ms) }` time source — inject a manual clock for deterministic TTL and backoff tests |

Durations accept `ms` numbers or strings: `'500ms'`, `'30s'`, `'10m'`, `'24h'`, `'7d'`.

Methods: `execute(input, fn)` · `executeWithMetadata(input, fn)` · `wrap(fn, { key })` · `get(key)` · `invalidate(key)`. The `fn` receives a context: `{ key, replayed, signal, extend(ttl), doNotStore() }` — `doNotStore()` keeps the lock's protection for concurrent callers while giving up the replay window, so an outcome that must not be served twice leaves no record behind.

## Documentation

- [Core semantics](docs/core.md) — state machine, TTLs, fingerprints, serialization rules, wait policy
- [Observability](docs/observability.md) — events, Prometheus metrics, OpenTelemetry spans
- [SQL storage](docs/sql.md) — migrations, lazy expiry, `sweep()`
- [HTTP adapters](docs/http.md) — options, error mapping, cacheability rules
- [NestJS](docs/nestjs.md) — module, interceptor, decorator
- [Writing an adapter](docs/writing-an-adapter.md) — Koa as the worked example
- [Benchmarks](docs/benchmarks.md) — what the guarantee costs per storage

Recipes — the non-HTTP callers are the headline:

- [RabbitMQ consumers](docs/rabbitmq.md) — key from `messageId`, outcomes mapped to ack/retry/DLQ
- [SQS consumers](docs/sqs.md) — dedup beyond FIFO's 5-minute window, on standard queues too
- [BullMQ processors](docs/bullmq.md) — content/intent idempotency beyond `jobId` dedup
- [Cron, workers and CLIs](docs/jobs.md) — one run per schedule slot, across replicas
- [breakwater](docs/breakwater.md) — resilience policies around storage calls

## Development

```bash
npm install
npm run hooks             # once per clone: lint + commit-message hooks
npm test                  # unit tests, no external services needed
npm run test:integration  # real Redis/Postgres/MySQL via Testcontainers (needs Docker)
npm run test:mutation     # Stryker mutation testing over the unit suite
npm run examples          # runnable, self-asserting examples
```

## Requirements

- Node.js >= 22
- Ships both ESM and CJS builds

## License

[MIT](LICENSE)
