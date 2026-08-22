// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold across entry points, so the
// build maps '../index' onto the shipped core bundle instead of inlining a
// private copy.
import { FencingError, IdempotencyKeyInvalidError, RECORD_STATUS } from '../index'
import type { IdempotencyStorage, Outcome, PendingRecord, StoredRecord } from '../index'
// Plain shared constants carry no identity requirement, so unlike the
// errors above they may come straight from the module that defines them.
import { MAX_ACQUIRE_ATTEMPTS, buildStoredRecord } from '../storage'

/**
 * Minimal DynamoDB attribute-value shapes. Only the three types this
 * adapter stores are described: the record is flat, so nothing nested is
 * ever read or written.
 */
type AttributeValue = { S: string } | { N: string } | { NULL: true }
type Item = Record<string, AttributeValue>

/**
 * Minimal `@aws-sdk/client-dynamodb` surface. Structural on purpose: a
 * DynamoDBClient satisfies it without quayside declaring a dependency on
 * the AWS SDK, exactly as the other adapters treat their drivers.
 */
export interface DynamoCommandClient {
  send (command: unknown): Promise<unknown>
}

/**
 * A command class from the SDK. The parameter is `never` so any of them is
 * assignable whatever its own input type is; the adapter builds the input
 * itself and casts at the single call site below.
 */
export type DynamoCommandConstructor = new (input: never) => unknown

/**
 * The command constructors the adapter needs. They are injected rather
 * than imported so the adapter never bundles the SDK: pass the classes
 * straight from `@aws-sdk/client-dynamodb`.
 */
export interface DynamoCommands {
  PutItemCommand: DynamoCommandConstructor
  GetItemCommand: DynamoCommandConstructor
  UpdateItemCommand: DynamoCommandConstructor
  DeleteItemCommand: DynamoCommandConstructor
}

export interface DynamoStorageOptions {
  /** Table holding the records. Default: 'quayside_records'. */
  tableName?: string
  /**
   * Byte capacity of the partition key. DynamoDB caps it at 2048 bytes;
   * longer keys are rejected rather than truncated.
   */
  maxKeyBytes?: number
}

const DEFAULT_TABLE = 'quayside_records'
// DynamoDB's own limit for a partition key value.
const DEFAULT_MAX_KEY_BYTES = 2048

// The attribute names. `record_key` matches the SQL adapters' column so a
// record reads the same whichever storage holds it.
const KEY = 'record_key'

function isConditionalCheckFailed (error: unknown): boolean {
  // Matched by name, never by message: DynamoDB Local and the service word
  // the failure differently, and only the name is contractual.
  return error instanceof Error && error.name === 'ConditionalCheckFailedException'
}

function stringOf (item: Item, field: string): string | undefined {
  const value = item[field]
  return value !== undefined && 'S' in value ? value.S : undefined
}

function numberOf (item: Item, field: string): string | undefined {
  const value = item[field]
  return value !== undefined && 'N' in value ? value.N : undefined
}

/**
 * DynamoDB storage adapter: a conditional `PutItem` is the atomic acquire
 * (the write *is* the lock) and every transition is a token-conditional
 * `UpdateItem`, so a stale holder's late write fails inside the service
 * rather than overwriting a newer execution.
 *
 * Expiry is enforced on read, exactly like the SQL adapters: DynamoDB's
 * native TTL deletes items on its own schedule (the service documents a
 * delay of up to 48 hours), so it is a garbage collector here, never the
 * authority on whether a record is still live.
 */
export class DynamoStorage implements IdempotencyStorage {
  private readonly client: DynamoCommandClient
  private readonly commands: DynamoCommands
  private readonly tableName: string
  private readonly maxKeyBytes: number

  constructor (client: DynamoCommandClient, commands: DynamoCommands, options: DynamoStorageOptions = {}) {
    this.client = client
    this.commands = commands
    this.tableName = options.tableName ?? DEFAULT_TABLE
    this.maxKeyBytes = options.maxKeyBytes ?? DEFAULT_MAX_KEY_BYTES
  }

  async acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null> {
    this.assertKeyFits(record.key)
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const now = Date.now()
      const item: Item = {
        [KEY]: { S: record.key },
        token: { S: record.token },
        status: { S: RECORD_STATUS.inProgress },
        stored_at: { N: String(record.storedAt) },
        expires_at: { N: String(now + lockTtlMs) },
        // The native TTL attribute is seconds since the epoch, and only
        // ever collects garbage: correctness comes from expires_at above.
        ttl: { N: String(Math.ceil((now + lockTtlMs) / 1_000) + 3_600) }
      }
      if (record.fingerprint !== undefined) item.fingerprint = { S: record.fingerprint }

      try {
        // Create-if-absent, or take over a record whose lease already ran
        // out: one conditional write covers both, so an expired holder
        // never blocks the key and no read-modify-write window exists.
        await this.send(this.commands.PutItemCommand, {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#key) OR expires_at <= :now',
          ExpressionAttributeNames: { '#key': KEY },
          ExpressionAttributeValues: { ':now': { N: String(now) } }
        })
        return null
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error
      }

      // Somebody live holds it: report their record, unless it expired
      // between the two calls, in which case contend again.
      const held = await this.get(record.key)
      if (held !== null) return held
    }
    throw new Error(`could not acquire or observe key "${record.key}" after ${MAX_ACQUIRE_ATTEMPTS} attempts`)
  }

  async complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const now = Date.now()
    const expiresAt = now + resultTtlMs
    const values: Record<string, AttributeValue> = {
      ':status': { S: outcome.status },
      ':expires': { N: String(expiresAt) },
      ':ttl': { N: String(Math.ceil(expiresAt / 1_000) + 3_600) },
      ':token': { S: token },
      ':inProgress': { S: RECORD_STATUS.inProgress },
      ':now': { N: String(now) },
      ':payload': { S: outcome.status === 'completed' ? outcome.result : outcome.error }
    }
    // `result`, `error`, `status` and `ttl` are all reserved words in
    // DynamoDB expressions, so every attribute this update touches goes
    // through a name placeholder.
    const payloadField = outcome.status === 'completed' ? 'result' : 'error'
    await this.fenced(key, {
      UpdateExpression: 'SET #status = :status, expires_at = :expires, #ttl = :ttl, #payload = :payload',
      ExpressionAttributeNames: { '#key': KEY, '#status': 'status', '#ttl': 'ttl', '#payload': payloadField },
      ExpressionAttributeValues: values
    })
  }

  async release (key: string, token: string): Promise<void> {
    try {
      await this.send(this.commands.DeleteItemCommand, {
        TableName: this.tableName,
        Key: { [KEY]: { S: key } },
        ConditionExpression: 'attribute_exists(#key) AND #token = :token AND #status = :inProgress AND expires_at > :now',
        ExpressionAttributeNames: { '#key': KEY, '#token': 'token', '#status': 'status' },
        ExpressionAttributeValues: {
          ':token': { S: token },
          ':inProgress': { S: RECORD_STATUS.inProgress },
          ':now': { N: String(Date.now()) }
        }
      })
    } catch (error) {
      if (isConditionalCheckFailed(error)) throw new FencingError(key)
      throw error
    }
  }

  async extend (key: string, token: string, lockTtlMs: number): Promise<void> {
    const expiresAt = Date.now() + lockTtlMs
    await this.fenced(key, {
      UpdateExpression: 'SET expires_at = :expires, #ttl = :ttl',
      ExpressionAttributeNames: { '#key': KEY, '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':expires': { N: String(expiresAt) },
        ':ttl': { N: String(Math.ceil(expiresAt / 1_000) + 3_600) },
        ':token': { S: token },
        ':inProgress': { S: RECORD_STATUS.inProgress },
        ':now': { N: String(Date.now()) }
      }
    })
  }

  async get (key: string): Promise<StoredRecord | null> {
    const answer = await this.send(this.commands.GetItemCommand, {
      TableName: this.tableName,
      Key: { [KEY]: { S: key } },
      // The lock and the fencing decisions read the record; a stale read
      // would let two holders believe they own the same key.
      ConsistentRead: true
    }) as { Item?: Item }
    const item = answer.Item
    if (item === undefined) return null
    const record = buildStoredRecord(key, {
      token: stringOf(item, 'token'),
      status: stringOf(item, 'status'),
      fingerprint: stringOf(item, 'fingerprint'),
      result: stringOf(item, 'result'),
      error: stringOf(item, 'error'),
      storedAt: numberOf(item, 'stored_at'),
      expiresAt: numberOf(item, 'expires_at')
    })
    // Expired reads as absent, whatever the native TTL has got around to.
    return record.expiresAt <= Date.now() ? null : record
  }

  async delete (key: string): Promise<void> {
    await this.send(this.commands.DeleteItemCommand, {
      TableName: this.tableName,
      Key: { [KEY]: { S: key } }
    })
  }

  // Every transition out of IN_PROGRESS carries the same guard: the record
  // exists, the token still matches, the status is still in-progress and
  // the lease has not run out.
  private async fenced (key: string, update: Record<string, unknown>): Promise<void> {
    try {
      await this.send(this.commands.UpdateItemCommand, {
        TableName: this.tableName,
        Key: { [KEY]: { S: key } },
        ConditionExpression: 'attribute_exists(#key) AND #token = :token AND #status = :inProgress AND expires_at > :now',
        ...update,
        ExpressionAttributeNames: {
          ...(update.ExpressionAttributeNames as Record<string, string>),
          '#token': 'token'
        }
      })
    } catch (error) {
      if (isConditionalCheckFailed(error)) throw new FencingError(key)
      throw error
    }
  }

  // The single place the built input meets the SDK's own input type.
  private async send (Command: DynamoCommandConstructor, input: Record<string, unknown>): Promise<unknown> {
    return this.client.send(new Command(input as never))
  }

  // The partition key is capped by the service itself: anything longer is
  // rejected here rather than reaching DynamoDB, so the failure names the
  // limit that was broken instead of surfacing a driver error.
  private assertKeyFits (key: string): void {
    const size = Buffer.byteLength(key)
    if (size > this.maxKeyBytes) {
      throw new IdempotencyKeyInvalidError(key, `idempotency key is ${size} bytes long and exceeds the ${this.maxKeyBytes}-byte partition key limit; keys are rejected, never truncated`)
    }
  }
}

/** The table definition, for CDK/Terraform users and for `migrate()`. */
export function dynamoTableDefinition (tableName: string = DEFAULT_TABLE): Record<string, unknown> {
  return {
    TableName: tableName,
    AttributeDefinitions: [{ AttributeName: KEY, AttributeType: 'S' }],
    KeySchema: [{ AttributeName: KEY, KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST'
  }
}
