# Recipe: idempotent SQS consumers

Two SQS facts make quayside a strong fit:

- **Standard queues have no deduplication at all** — at-least-once,
  occasionally more than once, by design.
- **FIFO content-based deduplication only covers a 5-minute window.** A
  duplicate `SendMessage` six minutes later goes through.

quayside extends the guarantee to `resultTtl` (24h by default) on **both**
queue types, and deduplicates at the *effect* level rather than the
enqueue level.

```ts
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { Idempotency } from 'quayside'
import { RedisStorage } from 'quayside/redis'

const idempotency = new Idempotency({
  storage: new RedisStorage(redis),
  namespace: 'orders-queue',
  onConflict: 'wait',
  lockTtl: '30s'   // keep below the queue's VisibilityTimeout (see below)
})

const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
  QueueUrl: queueUrl,
  WaitTimeSeconds: 20,
  MaxNumberOfMessages: 10
}))

for (const message of Messages) {
  // FIFO: MessageDeduplicationId names the intent. Standard: MessageId is
  // per-delivery, so prefer a business id from the body when you have one.
  const key = message.Attributes?.MessageDeduplicationId ?? message.MessageId
  const body = JSON.parse(message.Body ?? '{}')

  try {
    await idempotency.execute({ key: key as string, payload: body }, () => processOrder(body))
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
  } catch (error) {
    if (isBusinessRejection(error)) {
      // Permanent: delete (or let the redrive policy move it to the DLQ
      // after maxReceiveCount if you prefer the paper trail).
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
    }
    // Transient: do nothing — the visibility timeout expires and SQS
    // redelivers; the retry re-executes because failures are not cached.
  }
}
```

## Outcome mapping

| quayside outcome | What to do | Queue effect |
|---|---|---|
| Fresh execution succeeds / replay | `DeleteMessage` | done |
| Transient failure | nothing | visibility timeout expires → redelivery retries |
| Non-retryable business failure | `DeleteMessage` (or rely on redrive → DLQ) | stops retrying |

## VisibilityTimeout vs lockTtl

Keep **`VisibilityTimeout > lockTtl`**. If the visibility timeout is
shorter, SQS can redeliver while the first execution still holds the lock —
`onConflict: 'wait'` absorbs that race, but every redelivery burns a
receive. With the inequality respected, a crashed consumer's lock expires
*before* the message reappears, so the redelivery re-executes immediately
instead of waiting.
