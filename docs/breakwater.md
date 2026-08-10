# Recipe: breakwater policies around storage calls

quayside is fail-closed by design: when the idempotency storage is
unreachable, `execute` throws `StorageUnavailableError` instead of running
without the guarantee. [breakwater](https://github.com/pinceladasdaweb/breakwater)
policies compose naturally around the storage adapter to keep that failure
mode rare and fast — retry transient hiccups, cap latency, and trip a
breaker when Redis is genuinely down.

This is a recipe, not a hard dependency: quayside never imports breakwater.

```ts
import { resilience } from 'breakwater'
import { Idempotency } from 'quayside'
import type { IdempotencyStorage } from 'quayside'
import { RedisStorage } from 'quayside/redis'
import { Redis } from 'ioredis'

const policy = resilience({
  retry: { attempts: 3 },
  circuitBreaker: { name: 'idempotency-storage' },
  timeout: 500
})

function resilient (storage: IdempotencyStorage): IdempotencyStorage {
  return {
    acquire: (record, lockTtlMs) => policy.execute(() => storage.acquire(record, lockTtlMs)),
    complete: (key, token, outcome, resultTtlMs) => policy.execute(() => storage.complete(key, token, outcome, resultTtlMs)),
    release: (key, token) => policy.execute(() => storage.release(key, token)),
    extend: (key, token, lockTtlMs) => policy.execute(() => storage.extend(key, token, lockTtlMs)),
    get: (key) => policy.execute(() => storage.get(key)),
    delete: (key) => policy.execute(() => storage.delete(key)),
    // Deliberately NOT wrapped: waitForChange is a long wait by design and
    // a timeout policy would keep cutting it short for no benefit.
    waitForChange: storage.waitForChange?.bind(storage)
  }
}

const idempotency = new Idempotency({
  storage: resilient(new RedisStorage(new Redis()))
})
```

## Why each policy is safe here

- **Retry** — every storage operation tolerates a retry: `acquire` is
  create-if-absent (a duplicate attempt loses cleanly), and the fenced
  transitions (`complete`, `release`, `extend`) are token-guarded, so
  retrying one can never affect another holder's record.
- **Timeout** — bounds tail latency on the lock path. Keep it well below
  `lockTtl`; a storage call that outlives the lock is already lost.
- **Circuit breaker** — when Redis is down, an open breaker makes quayside
  fail closed *immediately* (`StorageUnavailableError`, HTTP `503`) instead
  of stacking timeouts. If availability matters more than the guarantee for
  a given domain, combine it with `onStorageError: 'open'` and monitor the
  `storage-bypass` events.
