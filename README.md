# quayside

> The quay is where cargo lands **once** — unloaded, registered, never processed twice.

Generic idempotency for Node.js: execute any operation exactly once per key, with pluggable storage, explicit concurrency semantics, and first-class observability.

**Status: under construction.** The core engine plus the in-memory and Redis storages are implemented; SQL storage and HTTP framework adapters are on the way.

## Quick start

```ts
import { Idempotency } from 'quayside'
import { MemoryStorage } from 'quayside/memory'

const idempotency = new Idempotency({
  storage: new MemoryStorage(),
  resultTtl: '24h',   // how long a completed result stays replayable
  lockTtl: '30s'      // how long a crashed execution blocks the key
})

// First call runs the function; any further call with the same key
// replays the stored result without running it again.
const result = await idempotency.execute('invoice:123', async () => {
  return createPayment()
})
```

Works in any framework — or no framework at all. REST handlers, queue consumers, cron jobs, workers, and CLI commands are all first-class callers:

```ts
// Raw usage in Express, no adapter needed
app.post('/payments', async (req, res) => {
  const result = await idempotency.execute(
    { key: req.headers['idempotency-key'] as string },
    () => createPayment(req.body)
  )
  res.json(result)
})
```

## Semantics in one minute

- **Exactly-once effect.** The first `execute` for a key atomically writes an `in-progress` record — that write *is* the lock. Success stores the serialized result for `resultTtl`; every later call replays it.
- **Two TTLs, not one.** `lockTtl` (default 30s) bounds crash recovery: if the process dies mid-flight, the key unblocks when the lock expires. `resultTtl` (default 24h) is the replay window. Long-running functions can heartbeat with `ctx.extend()`.
- **Fencing tokens.** Storage transitions (`complete`, `release`, `extend`) are fenced: a holder that lost its lock cannot overwrite the new holder's result — its late write fails with `FencingError`.
- **Failures are not idempotent** by default: a rejection deletes the record and retries run fresh. `persistFailures: true` opts into storing and replaying the error (for non-retryable business failures). A replayed failure is a reconstruction that preserves `name`, `message`, `stack`, own enumerable properties (`code`, `statusCode`, ...) and the `cause` chain — check `error.code`/fields on replay, not `instanceof`.
- **Payload fingerprints validate intent.** Pass `payload` alongside the key and quayside hashes it canonically (key-order, machine and locale independent): the same key with a different payload fails with `IdempotencyKeyReuseError` instead of silently replaying a result for another request.
- **No client key? Derive one.** `execute({ payload }, fn)` derives the key from the canonical payload hash — ideal for queue consumers — with `ignoreFields`/`pickFields` to exclude volatile fields (timestamps, request ids). The explicit key stays the primary mechanism; derivation is an opt-in convenience.
- **Key hygiene.** Namespace and key segments are percent-encoded before composition (a client-supplied key can never impersonate another namespace) and composed keys longer than `maxKeyLength` (default 512) are rejected — never truncated, because truncation is a silent collision.
- **Concurrency is a policy.** `onConflict: 'reject'` (default) throws `ConcurrentExecutionError` immediately; `'wait'` blocks until the winner finishes and replays its outcome, bounded by `waitTimeout`.
- **Fail closed.** If the storage is unreachable the call throws `StorageUnavailableError` instead of running without the guarantee. `onStorageError: 'open'` opts into availability instead: the function runs unguarded and every bypass emits a `storage-bypass` event.

## API sketch

```ts
// payload fingerprint: same key + different body => IdempotencyKeyReuseError
await idempotency.execute(
  { key: req.headers['idempotency-key'] as string, payload: req.body },
  () => createPayment(req.body)
)

// no client key: derive it from the payload (consumers, jobs)
await idempotency.execute(
  { payload: message.value, ignoreFields: ['meta.timestamp', 'requestId'] },
  () => processOrder(message.value)
)

// decorate once, call everywhere
const createOnce = idempotency.wrap(createPayment, {
  key: (input) => `payment:${input.invoiceId}`
})

// replay metadata
const { value, replayed, storedAt } = await idempotency.executeWithMetadata('invoice:123', fn)

// inspect / invalidate
await idempotency.get('invoice:123')
await idempotency.invalidate('invoice:123')

// typed events + metrics
new Idempotency({
  storage,
  onEvent: (event) => log.debug(event),          // acquired | replayed | conflict | completed | failed
  metrics: { onReplayed: (event) => counter.inc() }
})
```

All errors extend `QuaysideError` and carry a stable `code` (`IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_WAIT_TIMEOUT`, `IDEMPOTENCY_FENCING`, ...), so callers can map them without string-matching messages.

## Storage

```ts
import { MemoryStorage } from 'quayside/memory'   // tests and development
import { RedisStorage } from 'quayside/redis'     // production

// Bring your own client: any ioredis instance works, and so does a
// @pinceladasdaweb/redis RedisClient (its dedicated pub/sub connection is
// used for low-latency waits automatically).
const storage = new RedisStorage(new Redis())
```

The Redis adapter acquires with `SET NX PX` — the atomic write *is* the lock — and runs every fenced transition (`complete`, `release`, `extend`) as a Lua script on the server, so a stale holder can never overwrite a newer execution. `onConflict: 'wait'` wakes waiters through keyspace notifications when the server has `notify-keyspace-events` covering `K$gx`, and falls back to polling with exponential backoff when it does not. Every adapter passes the same storage-contract suite against a real server (Testcontainers), including a server-side `CLIENT KILL` mid-execution and a `SIGKILL` crash-recovery case.

Composing [breakwater](https://github.com/pinceladasdaweb/breakwater) resilience policies around storage calls is a documented recipe: see [docs/breakwater.md](docs/breakwater.md).

## Requirements

- Node.js >= 22
- Ships both ESM and CJS builds

## License

[MIT](LICENSE)
