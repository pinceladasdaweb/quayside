import { setTimeout as sleep } from 'node:timers/promises'

// Runtime imports come from '../index' on purpose: see the note above the
// storage exports in src/index.ts.
import {
  FencingError,
  RECORD_STATUS,
  SerializationError,
  assertKeyBytes,
  buildStoredRecord,
  contendAcquire
} from '../index'
import type { IdempotencyStorage, Outcome, PendingRecord, StoredRecord } from '../index'

/**
 * Minimal DynamoDB attribute-value shapes. Only the two types this adapter
 * stores are described: the record is flat, every field is a string or a
 * number, and absent fields are omitted rather than written as NULL.
 */
type AttributeValue = { S: string } | { N: string }
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
  /** Only `migrate()` needs these; omit them to keep the table yours. */
  CreateTableCommand?: DynamoCommandConstructor
  DescribeTableCommand?: DynamoCommandConstructor
  UpdateTimeToLiveCommand?: DynamoCommandConstructor
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

/**
 * DynamoDB caps an item at 400 KB, attribute names included. The guard
 * below keeps a margin under the service's exact figure for the key and
 * the fixed attributes, so an outcome that would be rejected by the
 * service is refused here with an error that names the actual limit
 * instead of surfacing as a ValidationException dressed up as an outage.
 */
const MAX_ITEM_BYTES = 399_000

// The attribute names. `record_key` matches the SQL adapters' column so a
// record reads the same whichever storage holds it.
const KEY = 'record_key'
// Collected by the service, never read by the adapter.
const TTL_ATTRIBUTE = 'ttl'

// How migrate() waits for the table to become ACTIVE. Constants, not
// options: no caller has a reason to tune the poll, and the sibling
// migrate() signatures are parameterless.
const MIGRATE_POLL_MS = 200
const MIGRATE_POLL_ATTEMPTS = 100

// Every transition out of IN_PROGRESS carries the same guard: the record
// exists, the token still matches, the status is still in-progress and the
// lease has not run out. One constant serves the fenced update and the
// fenced delete, so the two can never drift apart.
const FENCED_CONDITION = 'attribute_exists(#key) AND #token = :token AND #status = :inProgress AND expires_at > :now'

/**
 * When the service may collect an item, in epoch seconds. Deliberately a
 * day past the record's own expiry: collection is asynchronous and the
 * adapter must be the one deciding a record is gone, so the garbage
 * collector is never allowed to race the read that says so - the margin
 * also has to absorb clock skew between this process and AWS, since the
 * stamp is app-clock-based while the collector runs on AWS time. A day of
 * margin only costs later garbage collection.
 */
function collectorStamp (expiresAtMs: number): number {
  return Math.ceil(expiresAtMs / 1_000) + 86_400
}

function isConditionalCheckFailed (error: unknown): boolean {
  // Matched by name, never by message: DynamoDB Local and the service word
  // the failure differently, and only the name is contractual.
  return error instanceof Error && error.name === 'ConditionalCheckFailedException'
}

function isAlreadyExists (error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceInUseException'
}

function isTtlAlreadySettled (error: unknown): boolean {
  // Two ValidationException wordings mean the desired state already holds:
  // "TimeToLive is already enabled" (this boot lost a benign race with an
  // earlier one) and the modified-multiple-times rate limit (a concurrent
  // boot in the same fleet just enabled it). The message is the only thing
  // that says which validation failed, so it is matched loosely and only
  // here.
  return error instanceof Error &&
    error.name === 'ValidationException' &&
    (/TimeToLive is already enabled/i.test(error.message) ||
      /Time ?to ?live has been modified multiple times/i.test(error.message))
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
    assertKeyBytes(record.key, this.maxKeyBytes, 'partition key limit')
    return contendAcquire(record.key, async () => {
      const now = Date.now()
      const item: Item = {
        [KEY]: { S: record.key },
        token: { S: record.token },
        status: { S: RECORD_STATUS.inProgress },
        stored_at: { N: String(record.storedAt) },
        expires_at: { N: String(now + lockTtlMs) },
        // The native TTL attribute is seconds since the epoch, and only
        // ever collects garbage: correctness comes from expires_at above.
        [TTL_ATTRIBUTE]: { N: String(collectorStamp(now + lockTtlMs)) }
      }
      if (record.fingerprint !== undefined) item.fingerprint = { S: record.fingerprint }

      try {
        // Create-if-absent, or take over a record whose lease already ran
        // out: one conditional write covers both, so an expired holder
        // never blocks the key and no read-modify-write window exists. On
        // failure the service returns the blocking item inside the
        // exception, so the conflict costs no extra read.
        await this.send(this.commands.PutItemCommand, {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#key) OR expires_at <= :now',
          ExpressionAttributeNames: { '#key': KEY },
          ExpressionAttributeValues: { ':now': { N: String(now) } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
        })
        return null
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error
        return this.conflictingRecord(record, (error as { Item?: Item }).Item)
      }
    })
  }

  async complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const payload = outcome.status === 'completed' ? outcome.result : outcome.error
    // Refused before the write, and as a SerializationError rather than
    // anything storage-flavored: the storage is healthy and the value is
    // deterministic, so neither fail-open (an outage that is not one) nor
    // a corrupt classification (nothing stored is malformed) would be
    // honest about what happened.
    const size = Buffer.byteLength(payload) + Buffer.byteLength(key)
    if (size > MAX_ITEM_BYTES) {
      throw new SerializationError(`encoded outcome for key "${key}" is ${size} bytes and exceeds DynamoDB's 400 KB item limit, so it cannot be stored for replay`)
    }
    const now = Date.now()
    const expiresAt = now + resultTtlMs
    // `result`, `error`, `status` and `ttl` are all reserved words in
    // DynamoDB expressions, so every attribute this update touches goes
    // through a name placeholder.
    const payloadField = outcome.status === 'completed' ? 'result' : 'error'
    await this.fenced(key, token, now, {
      UpdateExpression: 'SET #status = :status, expires_at = :expires, #ttl = :ttl, #payload = :payload',
      ExpressionAttributeNames: { '#ttl': TTL_ATTRIBUTE, '#payload': payloadField },
      ExpressionAttributeValues: {
        ':status': { S: outcome.status },
        ':expires': { N: String(expiresAt) },
        ':ttl': { N: String(collectorStamp(expiresAt)) },
        ':payload': { S: payload }
      }
    })
  }

  async release (key: string, token: string): Promise<void> {
    try {
      await this.send(this.commands.DeleteItemCommand, {
        TableName: this.tableName,
        Key: { [KEY]: { S: key } },
        ConditionExpression: FENCED_CONDITION,
        ExpressionAttributeNames: this.fencedNames(),
        ExpressionAttributeValues: this.fencedValues(token, Date.now())
      })
    } catch (error) {
      this.rethrowFenced(key, error)
    }
  }

  async extend (key: string, token: string, lockTtlMs: number): Promise<void> {
    const now = Date.now()
    const expiresAt = now + lockTtlMs
    await this.fenced(key, token, now, {
      UpdateExpression: 'SET expires_at = :expires, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': TTL_ATTRIBUTE },
      ExpressionAttributeValues: {
        ':expires': { N: String(expiresAt) },
        ':ttl': { N: String(collectorStamp(expiresAt)) }
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
    return this.decodeLive(key, item)
  }

  async delete (key: string): Promise<void> {
    await this.send(this.commands.DeleteItemCommand, {
      TableName: this.tableName,
      Key: { [KEY]: { S: key } }
    })
  }

  /**
   * Creates the table and enables TTL when they do not exist yet, and
   * waits until the table is usable: DynamoDB creates asynchronously, so
   * a write issued right after CreateTable would fail. Idempotent, like
   * every migrate() here, so calling it on boot is safe.
   *
   * Requires the three management commands in the constructor's command
   * bag; without them the table is yours to provision (see
   * dynamoTableDefinition and dynamoTtlSpecification).
   */
  async migrate (): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } = this.commands
    if (CreateTableCommand === undefined || DescribeTableCommand === undefined || UpdateTimeToLiveCommand === undefined) {
      throw new TypeError('migrate() needs CreateTableCommand, DescribeTableCommand and UpdateTimeToLiveCommand in the commands passed to DynamoStorage')
    }

    try {
      await this.send(CreateTableCommand, dynamoTableDefinition(this.tableName))
    } catch (error) {
      // Already there: another process, an earlier boot, or Terraform.
      if (!isAlreadyExists(error)) throw error
    }

    let active = false
    for (let attempt = 0; attempt < MIGRATE_POLL_ATTEMPTS && !active; attempt += 1) {
      const described = await this.send(DescribeTableCommand, { TableName: this.tableName }) as {
        Table?: { TableStatus?: string }
      }
      active = described.Table?.TableStatus === 'ACTIVE'
      if (!active) await sleep(MIGRATE_POLL_MS)
    }
    if (!active) {
      // Proceeding would hand the TTL call an unready table and surface a
      // ResourceInUseException that names the wrong operation; the honest
      // failure is the readiness timeout itself.
      throw new Error(`table "${this.tableName}" did not become ACTIVE within ${MIGRATE_POLL_ATTEMPTS * MIGRATE_POLL_MS}ms; the control plane may be throttled - retry migrate() once it settles`)
    }

    try {
      await this.send(UpdateTimeToLiveCommand, dynamoTtlSpecification(this.tableName))
    } catch (error) {
      // An already-enabled TTL is the state this method wants, whichever
      // boot got there first. Nothing else about it is recoverable.
      if (!isTtlAlreadySettled(error)) throw error
    }
  }

  /**
   * What a failed conditional put means. The blocking item usually rides
   * in on the exception (ReturnValuesOnConditionCheckFailure); when a
   * client did not return it, one consistent read fetches it. `undefined`
   * asks the contention loop to try again: the holder expired between the
   * write and this look.
   */
  private async conflictingRecord (record: PendingRecord, returned: Item | undefined): Promise<StoredRecord | null | undefined> {
    const held = returned !== undefined
      ? this.decodeLive(record.key, returned)
      : await this.get(record.key)
    if (held === null) return undefined
    // The SDK retries a write whose response was lost, and the retry fails
    // its own condition against the item the first attempt stored: reading
    // our own token back means the acquire already succeeded, not that a
    // competitor holds the key.
    if (held.token === record.token) return null
    return held
  }

  /**
   * Decodes an item with the expiry check FIRST: an expired record reads
   * as absent whatever else is in it, exactly like every sibling adapter,
   * so an item that is both expired and malformed is reclaimable rather
   * than a corruption error acquire's takeover would happily overwrite. A
   * live item then validates through the shared decoder.
   */
  private decodeLive (key: string, item: Item): StoredRecord | null {
    const expiresAt = Number(numberOf(item, 'expires_at'))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null
    return buildStoredRecord(key, {
      token: stringOf(item, 'token'),
      status: stringOf(item, 'status'),
      fingerprint: stringOf(item, 'fingerprint'),
      result: stringOf(item, 'result'),
      error: stringOf(item, 'error'),
      storedAt: numberOf(item, 'stored_at'),
      expiresAt: numberOf(item, 'expires_at')
    })
  }

  // The fenced transition out of IN_PROGRESS: the guard's condition, name
  // and value placeholders are all built here, so a caller only supplies
  // what its own update expression adds and cannot forget (or misname) a
  // guard ingredient.
  private async fenced (key: string, token: string, now: number, update: {
    UpdateExpression: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
  }): Promise<void> {
    try {
      await this.send(this.commands.UpdateItemCommand, {
        TableName: this.tableName,
        Key: { [KEY]: { S: key } },
        ConditionExpression: FENCED_CONDITION,
        UpdateExpression: update.UpdateExpression,
        ExpressionAttributeNames: { ...this.fencedNames(), ...update.ExpressionAttributeNames },
        ExpressionAttributeValues: { ...this.fencedValues(token, now), ...update.ExpressionAttributeValues }
      })
    } catch (error) {
      this.rethrowFenced(key, error)
    }
  }

  // `status` is a reserved word in DynamoDB expressions; `token` and the
  // key attribute go through placeholders with it for uniformity.
  private fencedNames (): Record<string, string> {
    return { '#key': KEY, '#token': 'token', '#status': 'status' }
  }

  // `now` is the caller's single clock sample for the operation, so the
  // expiry it writes and the lease check the fence applies agree.
  private fencedValues (token: string, now: number): Record<string, AttributeValue> {
    return {
      ':token': { S: token },
      ':inProgress': { S: RECORD_STATUS.inProgress },
      ':now': { N: String(now) }
    }
  }

  private rethrowFenced (key: string, error: unknown): never {
    if (isConditionalCheckFailed(error)) throw new FencingError(key)
    throw error
  }

  // The single place the built input meets the SDK's own input type.
  private async send (Command: DynamoCommandConstructor, input: Record<string, unknown>): Promise<unknown> {
    return this.client.send(new Command(input as never))
  }
}

/**
 * The table definition, for CDK/Terraform/CloudFormation users and for
 * `migrate()`. A single string partition key is the whole schema: every
 * access is a point read or write by exact key, so there is no sort key
 * and no index to keep.
 *
 * Enable TTL on the `ttl` attribute separately (`migrate()` does it, and
 * `dynamoTtlSpecification` describes it): it only collects expired items,
 * never decides whether one is live.
 */
export function dynamoTableDefinition (tableName: string = DEFAULT_TABLE): Record<string, unknown> {
  return {
    TableName: tableName,
    AttributeDefinitions: [{ AttributeName: KEY, AttributeType: 'S' }],
    KeySchema: [{ AttributeName: KEY, KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST'
  }
}

/** The TTL configuration that pairs with the table above. */
export function dynamoTtlSpecification (tableName: string = DEFAULT_TABLE): Record<string, unknown> {
  return {
    TableName: tableName,
    TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true }
  }
}
