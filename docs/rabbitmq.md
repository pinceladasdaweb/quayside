# Recipe: idempotent RabbitMQ consumers

RabbitMQ delivers **at least once**: a connection drop after processing but
before the ack redelivers the message, and a competing consumer may receive
it again. quayside turns that into exactly-once *effect* — the work runs
once, redeliveries replay the stored outcome and ack cleanly.

The example uses [@pinceladasdaweb/rabbitmq](https://github.com/pinceladasdaweb/rabbitmq);
the pattern works with any AMQP client.

```ts
import { Idempotency } from 'quayside'
import { RedisStorage } from 'quayside/redis'
import RabbitMQ from '@pinceladasdaweb/rabbitmq'
import type { RetryableError } from '@pinceladasdaweb/rabbitmq'

const idempotency = new Idempotency({
  storage: new RedisStorage(redis),
  namespace: 'orders-consumer',
  onConflict: 'wait',        // a redelivery racing a live execution waits and replays
  persistFailures: true      // business rejections replay instead of re-running
})

await rabbitMQ.subscribe('orders', async (content, message) => {
  // Intent first: the publisher's messageId names the delivery. Fall back
  // to a payload-derived key when publishers do not set one.
  const key = message.properties.messageId
  await idempotency.execute(
    key !== undefined
      ? { key, payload: content }
      : { payload: content, ignoreFields: ['meta.timestamp'] },
    async () => processOrder(content)
  )
  // resolving acks; quayside guarantees processOrder ran at most once
}, { retryPolicy: 'once' })
```

## Outcome mapping

| quayside outcome | What to do | Broker effect |
|---|---|---|
| Fresh execution succeeds / replay | return normally | ack |
| Transient failure (default: record deleted) | rethrow | retryPolicy requeues; the retry re-executes |
| Non-retryable business failure | rethrow with `retryable = false` | straight to the DLQ |
| Replayed persisted failure | same as above — check `error.code` | DLQ without re-running the work |

```ts
try {
  await idempotency.execute({ key, payload: content }, () => processOrder(content))
} catch (error) {
  if (isBusinessRejection(error)) {
    (error as RetryableError).retryable = false // DLQ, do not retry
  }
  throw error
}
```

## Why `onConflict: 'wait'`

With prefetch > 1 or competing consumers, a redelivery can arrive while the
first delivery is still executing. `'wait'` parks it until the winner
finishes and replays the result — without it the redelivery would fail with
`ConcurrentExecutionError` and burn a retry.

Size the subscription against the lock: the handler's expected duration
should stay well below `lockTtl`, or call `ctx.extend()` periodically for
long-running work.
