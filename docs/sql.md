# SQL storage (PostgreSQL and MySQL)

Both adapters share one algorithm: the insert-if-absent is the atomic
acquire, expired rows are reclaimed in place, and every fenced transition
(`complete`, `release`, `extend`) is a single token-conditional
`UPDATE`/`DELETE` — atomicity lives in the database, never in
read-modify-write JavaScript.

## Usage

```ts
import { Idempotency } from 'quayside'
import { PostgresStorage } from 'quayside/postgres'
// or: import { MysqlStorage } from 'quayside/mysql'

const storage = new PostgresStorage(pool)   // any pg Pool/Client
await storage.migrate()                     // CREATE TABLE IF NOT EXISTS

const idempotency = new Idempotency({ storage })
```

Bring your own client, typed structurally: any `pg` Pool, Client or
PoolClient for Postgres; any `mysql2/promise` Pool or Connection for MySQL.
No driver dependency is declared.

Options: `tableName` (default `quayside_records`, validated against
`[A-Za-z0-9_]`) and `maxKeyBytes` (default 512, matching the key column).

## Migrations

`migrate()` creates the table and its expiry index when they do not exist.
For external migration tools, the DDL is exported as a string:

```ts
import { postgresMigration } from 'quayside/postgres'
import { mysqlMigration } from 'quayside/mysql'

console.log(postgresMigration())           // default table name
console.log(mysqlMigration('my_records'))  // custom table name
```

## Expiry without a cron

Expired rows are invisible to every read (`expires_at > now` on each
statement) and are reclaimed in place by the next `acquire` on the same key
— correctness never requires a cleanup job. For bulk housekeeping there is
an optional `sweep()`:

```ts
const removed = await storage.sweep()  // DELETE ... WHERE expires_at <= now
```

Run it from a cron if table size matters; skip it if it does not.

## Notes

- **Keys are rejected, never truncated.** The key column is
  `VARCHAR(512)`; the adapter rejects longer keys before any statement
  touches the database, so a MySQL server in non-strict `sql_mode` can
  never truncate a key into a silent collision. The rejection raises
  `IdempotencyKeyInvalidError` (the HTTP adapters answer `400`): the
  offending value is client data, not an outage, so `onStorageError:
  'open'` deliberately does not wave it through unguarded.
- **A row the record contract cannot describe raises
  `StorageCorruptError`** — a status outside the state machine, a
  non-string token, a timestamp that does not parse. Fail-open does not
  cover it either, for the same reason: it is a data bug, not an outage,
  and it would decode the same way on every retry.
- **Timestamps are compared in the client's clock** (epoch ms as `BIGINT`),
  the same convention as every other adapter — the database server's clock
  is irrelevant.
- **MySQL result columns are `MEDIUMTEXT`** (16 MiB), comfortably above the
  HTTP kernel's 1 MiB `maxBodyBytes` default.
- **No notification channel**: SQL waiters poll with the standard
  exponential backoff. If you need low-latency waits, prefer the Redis
  adapter for those domains.
