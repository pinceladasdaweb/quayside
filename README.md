# quayside

> The quay is where cargo lands **once** — unloaded, registered, never processed twice.

Generic idempotency for Node.js: execute any operation exactly once per key, with pluggable storage, explicit concurrency semantics, and first-class observability.

**Status: under construction.** The core engine and the in-memory storage are implemented; Redis/SQL storage and HTTP framework adapters are on the way.

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
- **Failures are not idempotent** by default: a rejection deletes the record and retries run fresh. `persistFailures: true` opts into storing and replaying the error (for non-retryable business failures).
- **Concurrency is a policy.** `onConflict: 'reject'` (default) throws `ConcurrentExecutionError` immediately; `'wait'` blocks until the winner finishes and replays its outcome, bounded by `waitTimeout`.
- **Fail closed.** If the storage is unreachable the call throws `StorageUnavailableError` instead of running without the guarantee.

## API sketch

```ts
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

## Requirements

- Node.js >= 22
- Ships both ESM and CJS builds

## License

[MIT](LICENSE)
