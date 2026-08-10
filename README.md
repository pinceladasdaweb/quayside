# quayside

> The quay is where cargo lands **once** — unloaded, registered, never processed twice.

Generic idempotency for Node.js: execute any operation exactly once per key, with pluggable storage, explicit concurrency semantics, and first-class observability.

**Status: under construction.** The public API is designed and frozen; implementation is in progress.

## What it will look like

```ts
import { Idempotency } from 'quayside'
import { MemoryStorage } from 'quayside/memory'

const idempotency = new Idempotency({
  storage: new MemoryStorage(),
  resultTtl: '24h',
  lockTtl: '30s',
})

// Works in any framework — or no framework at all.
const result = await idempotency.execute('invoice:123', async () => {
  return createPayment()
})
```

The core knows nothing about HTTP: REST handlers, queue consumers, cron jobs, workers, and CLI commands are all first-class callers. HTTP adapters (Express, Fastify, Hono, NestJS) add protocol semantics — faithful status/header replay, IETF `Idempotency-Key` error mapping — on top of the same primitive.

## Requirements

- Node.js >= 22
- Ships both ESM and CJS builds

## License

[MIT](LICENSE)
