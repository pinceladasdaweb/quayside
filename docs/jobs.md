# Recipe: cron jobs, workers and CLIs

Non-HTTP callers are first-class in quayside — no adapter, no header, just
`execute()` with a key that names the unit of work. The pattern is always
the same: **the key encodes the intent and its period or scope**, so
concurrent and repeated invocations collapse into one execution.

## Cron: one run per schedule slot, across replicas

Three replicas all fire the same cron at 03:00. Key the *slot*, and two of
them replay:

```ts
import { Idempotency } from 'quayside'
import { PostgresStorage } from 'quayside/postgres'

const idempotency = new Idempotency({
  storage: new PostgresStorage(pool),   // shared by all replicas
  namespace: 'cron',
  resultTtl: '48h',
  lockTtl: '10m'                        // must outlive the longest run, or heartbeat
})

cron.schedule('0 3 * * *', async () => {
  const slot = new Date().toISOString().slice(0, 10)   // 2026-08-13
  const report = await idempotency.execute(`daily-report:${slot}`, async (ctx) => {
    // long job? push the lock forward as you make progress
    await ctx.extend('10m')
    return buildDailyReport(slot)
  })
})
```

A crashed run unblocks after `lockTtl` and the next attempt re-executes; a
completed run replays for `resultTtl` no matter which replica asks.

## Workers: dedup by business intent

```ts
const settleOnce = idempotency.wrap(settleInvoice, {
  key: (invoice) => `settle:${invoice.id}`
})

for (const invoice of await findPendingInvoices()) {
  await settleOnce(invoice)   // safe to run the sweep concurrently elsewhere
}
```

Two worker processes sweeping the same table cannot double-settle: one
executes, the other rejects (or waits, with `onConflict: 'wait'`) and
replays.

## CLI: safe re-runs of side-effectful commands

```ts
// migrate-tenant.ts <tenantId>
const outcome = await idempotency.executeWithMetadata(
  `migrate-tenant:${tenantId}`,
  () => migrateTenant(tenantId)
)
console.log(outcome.replayed
  ? `already migrated at ${new Date(outcome.storedAt).toISOString()}`
  : 'migrated now')
```

An operator running the command twice — or two operators running it at
once — is exactly the failure mode the fencing discipline exists for.

## Choosing keys

| Caller | Key shape |
|---|---|
| Cron | `job-name:period-bucket` (`daily-report:2026-08-13`) |
| Worker sweep | `action:business-id` (`settle:invoice-123`) |
| CLI | `command:target` (`migrate-tenant:acme`) |
| Consumer without ids | derive from the payload with `ignoreFields` |
