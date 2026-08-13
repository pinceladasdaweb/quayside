# Recipe: idempotent BullMQ processors

BullMQ deduplicates at the *enqueue* level, by `jobId`: adding a job whose
id already exists is a no-op. That covers accidental double-adds, but not:

- two **different** jobs carrying the same business intent (the producer
  did not know a jobId that encodes it),
- a processor that crashed after the side effect but before completing —
  the retry runs the side effect again,
- replaying the original result to later duplicates after the job data has
  left the queue.

Running `execute()` inside the processor closes all three, with zero
adapters:

```ts
import { Worker } from 'bullmq'
import { Idempotency } from 'quayside'
import { RedisStorage } from 'quayside/redis'

const idempotency = new Idempotency({
  storage: new RedisStorage(redis),   // reuse the same Redis as BullMQ
  namespace: 'email-jobs',
  onConflict: 'wait'
})

const worker = new Worker('emails', async (job) => {
  // The key names the business intent, not the job instance.
  return idempotency.execute(
    { key: `welcome-email:${job.data.userId}`, payload: job.data },
    async (ctx) => {
      // BullMQ retries reuse the same key: a retry after a crash
      // re-executes (the lock expired), a retry after success replays.
      return sendWelcomeEmail(job.data)
    }
  )
}, { connection })
```

## Outcome mapping

| Situation | Behavior |
|---|---|
| First processing succeeds | side effect runs once; result stored for `resultTtl` |
| BullMQ retry after a crash | lock expired → re-executes (the work never completed) |
| BullMQ retry after success (e.g. crash post-completion) | replays the stored result — the side effect does **not** run again |
| A different job, same intent key | replays instead of duplicating the side effect |
| Business rejection with `persistFailures: true` | the retry replays the failure; pair it with `attempts: 1` or check `error.code` to move the job to failed |

One caveat: quayside's lock is per-*key*, BullMQ's concurrency is
per-*worker*. With `concurrency > 1`, two jobs with the same intent key can
land simultaneously — `onConflict: 'wait'` makes the loser wait and replay
instead of failing.
