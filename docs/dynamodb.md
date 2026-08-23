# DynamoDB storage

A conditional `PutItem` is the atomic acquire — the write *is* the lock —
and every fenced transition (`complete`, `release`, `extend`) is a single
token-conditional `UpdateItem`/`DeleteItem`. Atomicity lives in the
service, never in read-modify-write JavaScript, exactly as it does in Lua
on Redis and in token-conditional statements on SQL.

## Usage

```ts
import { Idempotency } from 'quayside'
import { DynamoStorage } from 'quayside/dynamodb'
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand
} from '@aws-sdk/client-dynamodb'

const client = new DynamoDBClient({ region: 'eu-west-1' })

const storage = new DynamoStorage(client, {
  PutItemCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand
})

const idempotency = new Idempotency({ storage })
```

The command classes are passed in rather than imported by the adapter, so
quayside never bundles the AWS SDK and your bundler keeps tree-shaking it:
the library declares no dependency on `@aws-sdk/client-dynamodb`, and the
client is typed structurally like every other driver here.

Options: `tableName` (default `quayside_records`) and `maxKeyBytes`
(default 2048, DynamoDB's own partition-key limit). A key over the limit
raises `IdempotencyKeyInvalidError` — the HTTP adapters answer `400` —
rather than being truncated into a silent collision.

## The table

One string partition key, no sort key, no index: every access is a point
read or write by exact key.

`migrate()` creates the table, waits for it to become `ACTIVE` (DynamoDB
creates asynchronously, so a write issued immediately after `CreateTable`
would fail) and enables TTL. It is idempotent, so calling it on boot is
safe. It needs three more commands in the bag:

```ts
import { CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb'

const storage = new DynamoStorage(client, {
  PutItemCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand,
  CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand
})
await storage.migrate()
```

Provisioning the table with CDK, Terraform or CloudFormation instead is
the common case in production, and then those three commands are not
needed at all. The definitions are exported for it:

```ts
import { dynamoTableDefinition, dynamoTtlSpecification } from 'quayside/dynamodb'

console.log(dynamoTableDefinition())            // default table name
console.log(dynamoTtlSpecification('my_table')) // TTL on the `ttl` attribute
```

| Attribute | Type | Meaning |
|---|---|---|
| `record_key` | `S` (partition key) | The composed idempotency key |
| `token` | `S` | Fencing token of the current holder |
| `status` | `S` | `in-progress`, `completed` or `failed` |
| `fingerprint` | `S` | Payload fingerprint, when the call carried a payload |
| `result` / `error` | `S` | The encoded outcome, whichever applies |
| `stored_at` | `N` | When the execution started (epoch ms) |
| `expires_at` | `N` | When the record stops being live (epoch ms) — **the authority** |
| `ttl` | `N` | Epoch *seconds* for the service's collector — never read by the adapter |

## Why the native TTL is not the expiry

DynamoDB's TTL deletes expired items on its own schedule: the service
documents a delay of up to 48 hours. Treating it as the expiry would break
the invariant every storage adapter here is held to — **an expired record
reads as absent** — and a lock whose holder crashed would stay held for as
long as the collector took to notice.

So `expires_at` is the authority and every read compares against it, while
the `ttl` attribute is written a day past that, purely so the table does
not grow forever. The wide margin is deliberate: the stamp comes from the
application's clock while the collector runs on AWS time, and a day absorbs
any realistic skew at the cost of nothing but later garbage collection. The
adapter is correct with TTL disabled; it just accumulates dead items.

The same reasoning makes the acquire a single conditional write:

```
attribute_not_exists(record_key) OR expires_at <= :now
```

Create-if-absent and expired-record takeover in one operation, so there is
no window between reading a record and deciding to replace it.

One thing to know about that takeover: the comparison runs inside DynamoDB
against a timestamp *written by whichever client acquired last*, so the
takeover is only as honest as the fleet's clocks. A client running far
ahead of its peers can consider a live lock expired and steal it (fencing
then stops the stale holder's *write*, never its side effects). This is the
same convention the SQL adapters document; keep the fleet on NTP and give
`lockTtl` comfortable margin over both the execution time and the plausible
skew.

## Consistency

Every read the lock depends on uses `ConsistentRead: true`. An eventually
consistent read could show a stale record and let two callers believe they
hold the same key, which is precisely the guarantee this library sells.

## The 400 KB item limit

DynamoDB rejects any item over 400 KB, and the stored outcome (the encoded
result or error) lives inside the item. The adapter refuses an outcome that
cannot fit *before* the write, with a `SerializationError`: the engine then
releases the record so callers may retry, exactly as it does for a value
the codec could not encode — this is not an outage (fail-open will not run
unguarded over it) and not corruption (nothing stored is malformed), it is
a value this storage cannot hold.

On HTTP apps backed by this adapter, cap the replayable response body below
the item limit so the refusal never triggers: `maxBodyBytes: 380_000` (the
kernel serves larger responses fine; it just never caches them, which is
the honest behavior for a body DynamoDB could not store anyway).

## Costs

Each `execute` is one conditional write (the acquire) plus one write (the
transition), and a replay is one strongly consistent read. A conflict costs
nothing extra: the blocking item rides back on the failed conditional write
(`ReturnValuesOnConditionCheckFailure`), so the busy answer and the replay
of a completed record are read straight off the exception. The wait policy
adds one read per poll. Strongly consistent reads cost twice an eventually
consistent one and cannot be served from DAX — budget accordingly on hot
keys.

## Testing

The integration suite runs against `amazon/dynamodb-local` through
Testcontainers, with no AWS account and no credentials involved. Two flags
matter: `-inMemory` keeps the run fast and leaves nothing behind, and
`-sharedDb` is load-bearing — without it DynamoDB Local partitions its
storage per credential and region pair, so a client that differs in either
sees an empty table.
