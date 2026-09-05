import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  UpdateTimeToLiveCommand
} from '@aws-sdk/client-dynamodb'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { ConcurrentExecutionError, Idempotency, SerializationError, StorageCorruptError } from '../../src/index'
import { DynamoStorage } from '../../src/dynamodb/index'
import { runStorageContract } from '../contract/storage-contract'

let container: StartedTestContainer
let client: DynamoDBClient
let storage: DynamoStorage

const commands = {
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand
}

before(async () => {
  // -inMemory keeps the run fast and leaves nothing behind; -sharedDb is
  // load-bearing, not tidiness: without it DynamoDB Local partitions its
  // storage per credential+region pair, so a client that differs in either
  // would not see the table this suite creates.
  container = await new GenericContainer('amazon/dynamodb-local:2.5.2')
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(180_000)
    .start()

  client = new DynamoDBClient({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    region: 'local',
    // DynamoDB Local accepts any credential; these are never real.
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
  })
  storage = new DynamoStorage(client, commands)
  await storage.migrate()
})

after(async () => {
  client.destroy()
  await container.stop()
})

// A fresh table per contract run would cost a create/delete round trip per
// test; clearing the keys the suite uses is enough, since every test names
// its own.
async function clear (): Promise<void> {
  for (const key of ['k1', 'ghost', `ns:${'x'.repeat(600)}:suffix`]) {
    await storage.delete(key)
  }
}

runStorageContract('DynamoStorage', async () => {
  await clear()
  return storage
})

describe('DynamoStorage specifics', () => {
  test('migrate is idempotent and leaves the table usable', async () => {
    // Running it on every boot is the documented pattern, so the second
    // call must be a no-op rather than a ResourceInUseException, and the
    // already-enabled TTL must not fail either.
    await storage.migrate()
    await storage.migrate()
    await storage.delete('after-migrate')
    assert.equal(await storage.acquire({ key: 'after-migrate', token: 't', storedAt: Date.now() }, 1_000), null)

    const ttl = await client.send(new DescribeTableCommand({ TableName: 'quayside_records' }))
    assert.equal(ttl.Table?.TableStatus, 'ACTIVE')
  })

  test('migrate refuses to run without the management commands', async () => {
    const limited = new DynamoStorage(client, {
      PutItemCommand,
      GetItemCommand,
      UpdateItemCommand,
      DeleteItemCommand
    })
    await assert.rejects(limited.migrate(), TypeError, 'the missing commands are named, not silently skipped')
  })

  test('a key over the partition-key limit is rejected, never truncated', async () => {
    const tiny = new DynamoStorage(client, commands, { maxKeyBytes: 16 })
    await assert.rejects(
      tiny.acquire({ key: 'x'.repeat(17), token: 't', storedAt: Date.now() }, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: string }).code, 'IDEMPOTENCY_KEY_INVALID')
        return true
      }
    )
  })

  test('the engine runs exactly once per key across concurrent callers', async () => {
    await storage.delete('race')
    const idempotency = new Idempotency({ storage })
    let calls = 0
    const attempts = Array.from({ length: 20 }, async () =>
      idempotency.execute('race', async () => {
        calls += 1
        return 'once'
      }).catch((error: unknown) => error)
    )
    const outcomes = await Promise.all(attempts)
    assert.equal(calls, 1, 'exactly one execution won the key')
    const values = outcomes.filter((outcome) => outcome === 'once')
    assert.ok(values.length >= 1)
  })

  test('a lock left by a dead holder is reclaimed once it expires', async () => {
    await storage.delete('crashed')
    // No release, no completion: the holder simply vanished.
    await storage.acquire({ key: 'crashed', token: 'gone', storedAt: Date.now() }, 40)
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(await storage.get('crashed'), null, 'an expired lease reads as absent')
    const idempotency = new Idempotency({ storage })
    assert.equal(await idempotency.execute('crashed', async () => 'recovered'), 'recovered')
  })

  test('a stale holder cannot overwrite the record that replaced it', async () => {
    await storage.delete('split')
    await storage.acquire({ key: 'split', token: 'first', storedAt: Date.now() }, 40)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // The new holder takes the expired key over.
    assert.equal(await storage.acquire({ key: 'split', token: 'second', storedAt: Date.now() }, 5_000), null)

    await assert.rejects(
      storage.complete('split', 'first', { status: 'completed', result: '"stale"' }, 5_000),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'IDEMPOTENCY_FENCING')
        return true
      }
    )
    const record = await storage.get('split')
    assert.equal(record?.token, 'second')
    assert.equal(record?.result, undefined, 'the late write never landed')
  })

  test('a failed conditional put carries the blocking item on the exception', async () => {
    // The acquire's conflict path reads the holder off the exception
    // (ReturnValuesOnConditionCheckFailure) instead of paying a second
    // round-trip; this pins that DynamoDB Local actually populates it, so
    // the suite is exercising the single-call path and not silently living
    // off the get() fallback.
    await storage.delete('conflict-item')
    await storage.acquire({ key: 'conflict-item', token: 'holder', storedAt: Date.now() }, 5_000)
    await assert.rejects(
      client.send(new PutItemCommand({
        TableName: 'quayside_records',
        Item: { record_key: { S: 'conflict-item' }, token: { S: 'challenger' } },
        ConditionExpression: 'attribute_not_exists(record_key)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
      })),
      (error: unknown) => {
        assert.equal((error as Error).name, 'ConditionalCheckFailedException')
        const item = (error as { Item?: Record<string, { S?: string }> }).Item
        assert.ok(item, 'the blocking item rides in on the exception')
        assert.equal(item.token?.S, 'holder')
        return true
      }
    )
  })

  test('exhausting the contention loop is contention, never corruption or an outage', async () => {
    // A structural stub whose put always loses its condition and whose get
    // never sees a record: the storage answers every call, so the failure
    // is data the contract cannot describe, never an outage fail-open may
    // run unguarded over. Deterministic where a live server cannot be.
    class FakePut { constructor (readonly input: unknown) {} }
    class FakeGet { constructor (readonly input: unknown) {} }
    let reads = 0
    const stub = new DynamoStorage({
      send: async (command: unknown) => {
        if (command instanceof FakePut) {
          const refused = new Error('conditional request failed')
          refused.name = 'ConditionalCheckFailedException'
          throw refused
        }
        reads += 1
        return {}
      }
    }, { ...commands, PutItemCommand: FakePut, GetItemCommand: FakeGet })

    await assert.rejects(
      stub.acquire({ key: 'starved', token: 't', storedAt: Date.now() }, 1_000),
      (error: unknown) => {
        // Every lost turn means the key was held by someone who let go a
        // moment later: a key in use, so the retryable conflict, not a 500.
        assert.ok(error instanceof ConcurrentExecutionError)
        assert.equal(error.code, 'IDEMPOTENCY_IN_PROGRESS')
        return true
      }
    )
    assert.equal(reads, 5, 'the loop is bounded, never infinite')
  })

  test('an SDK retry of its own successful put reads as acquired, not as a competitor', async () => {
    // A lost response makes the SDK retry a PutItem that already landed;
    // the retry fails its own condition against the item the first attempt
    // wrote. Reading our own token back means the acquire succeeded: the
    // engine must not answer its only caller with a 409 and leave the key
    // locked for the full lock TTL.
    class FakePut { constructor (readonly input: unknown) {} }
    const ownItem = {
      record_key: { S: 'self' },
      token: { S: 'mine' },
      status: { S: 'in-progress' },
      stored_at: { N: '1000' },
      expires_at: { N: String(Date.now() + 60_000) }
    }
    let reads = 0
    const stub = new DynamoStorage({
      send: async (command: unknown) => {
        if (command instanceof FakePut) {
          const refused = Object.assign(new Error('conditional request failed'), { Item: ownItem })
          refused.name = 'ConditionalCheckFailedException'
          throw refused
        }
        reads += 1
        return { Item: ownItem }
      }
    }, { ...commands, PutItemCommand: FakePut })

    assert.equal(await stub.acquire({ key: 'self', token: 'mine', storedAt: 1_000 }, 60_000), null)
    assert.equal(reads, 0, 'the holder came off the exception; the conflict cost no extra read')

    // The same recognition when a client did not return the item on the
    // exception: the fallback read finds our own token.
    class BarePut { constructor (readonly input: unknown) {} }
    const fallback = new DynamoStorage({
      send: async (command: unknown) => {
        if (command instanceof BarePut) {
          const refused = new Error('conditional request failed')
          refused.name = 'ConditionalCheckFailedException'
          throw refused
        }
        return { Item: ownItem }
      }
    }, { ...commands, PutItemCommand: BarePut })
    assert.equal(await fallback.acquire({ key: 'self', token: 'mine', storedAt: 1_000 }, 60_000), null)
  })

  test('an outcome over the item limit is refused before the write, as unstorable', async () => {
    await storage.delete('oversize')
    await storage.acquire({ key: 'oversize', token: 't', storedAt: Date.now() }, 5_000)
    await assert.rejects(
      storage.complete('oversize', 't', { status: 'completed', result: 'x'.repeat(400_000) }, 5_000),
      (error: unknown) => {
        assert.ok(error instanceof SerializationError, 'neither an outage nor corruption: the storage is healthy and nothing stored is malformed')
        assert.equal(error.code, 'IDEMPOTENCY_SERIALIZATION')
        assert.match(error.message, /400 KB item limit/)
        return true
      }
    )
    const record = await storage.get('oversize')
    assert.equal(record?.status, 'in-progress', 'nothing bogus was written')
  })

  test('migrate fails loudly when the table never becomes ACTIVE', async () => {
    class FakeCreate { constructor (readonly input: unknown) {} }
    class FakeDescribe { constructor (readonly input: unknown) {} }
    const stuck = new DynamoStorage({
      send: async (command: unknown) => {
        if (command instanceof FakeCreate) {
          const exists = new Error('already exists')
          exists.name = 'ResourceInUseException'
          throw exists
        }
        if (command instanceof FakeDescribe) return { Table: { TableStatus: 'CREATING' } }
        return {}
      }
    }, { ...commands, CreateTableCommand: FakeCreate, DescribeTableCommand: FakeDescribe })

    // Proceeding would hand the TTL call an unready table and surface an
    // error naming the wrong operation; the honest failure is the timeout.
    await assert.rejects(stuck.migrate(), /did not become ACTIVE within \d+ms/)
  })

  test('migrate tolerates the TTL rate-limit a concurrent fleet boot provokes', async () => {
    // Two instances booting together race UpdateTimeToLive; the loser gets
    // AWS's modified-multiple-times ValidationException. The desired state
    // holds either way, so the boot must not crash over it.
    class FakeCreate { constructor (readonly input: unknown) {} }
    class FakeDescribe { constructor (readonly input: unknown) {} }
    class FakeTtl { constructor (readonly input: unknown) {} }
    const racing = new DynamoStorage({
      send: async (command: unknown) => {
        if (command instanceof FakeCreate) {
          const exists = new Error('already exists')
          exists.name = 'ResourceInUseException'
          throw exists
        }
        if (command instanceof FakeDescribe) return { Table: { TableStatus: 'ACTIVE' } }
        if (command instanceof FakeTtl) {
          const limited = new Error('Time to live has been modified multiple times within a fixed interval')
          limited.name = 'ValidationException'
          throw limited
        }
        return {}
      }
    }, {
      ...commands,
      CreateTableCommand: FakeCreate,
      DescribeTableCommand: FakeDescribe,
      UpdateTimeToLiveCommand: FakeTtl
    })
    await assert.doesNotReject(racing.migrate())
  })

  test('an expired record reads as absent even when the rest of it is malformed', async () => {
    // Expiry is decided before validation, exactly like every sibling: an
    // item acquire's takeover would happily reclaim must not read as a
    // corruption error in the meantime.
    await client.send(new PutItemCommand({
      TableName: 'quayside_records',
      Item: {
        record_key: { S: 'expired-junk' },
        status: { S: 'half-done' },
        expires_at: { N: String(Date.now() - 1_000) }
      }
    }))
    assert.equal(await storage.get('expired-junk'), null)
    // The same junk while still live IS corruption: the classification
    // only yields to expiry, never to malformed data in general.
    await client.send(new PutItemCommand({
      TableName: 'quayside_records',
      Item: {
        record_key: { S: 'live-junk' },
        status: { S: 'half-done' },
        expires_at: { N: String(Date.now() + 60_000) }
      }
    }))
    await assert.rejects(storage.get('live-junk'), StorageCorruptError)
    await storage.delete('live-junk')
    await storage.delete('expired-junk')
  })

  test('the native ttl attribute is written but never trusted for expiry', async () => {
    // DynamoDB deletes expired items on its own schedule (documented as up
    // to 48h), so the adapter keeps its own expires_at and reads through
    // it. The attribute exists only so the table does not grow forever.
    await storage.delete('ttl-attr')
    await storage.acquire({ key: 'ttl-attr', token: 't', storedAt: Date.now() }, 30)
    const raw = await client.send(new GetItemCommand({
      TableName: 'quayside_records',
      Key: { record_key: { S: 'ttl-attr' } },
      ConsistentRead: true
    }))
    assert.ok(raw.Item?.ttl?.N, 'the collector attribute is set')

    await new Promise((resolve) => setTimeout(resolve, 50))
    // The item is still physically there, and still reads as absent.
    const stillStored = await client.send(new GetItemCommand({
      TableName: 'quayside_records',
      Key: { record_key: { S: 'ttl-attr' } },
      ConsistentRead: true
    }))
    assert.ok(stillStored.Item, 'nothing collected it yet')
    assert.equal(await storage.get('ttl-attr'), null, 'and the adapter still reads it as expired')
  })
})
