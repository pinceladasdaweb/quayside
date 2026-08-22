import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CreateTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand
} from '@aws-sdk/client-dynamodb'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { Idempotency } from '../../src/index'
import { DynamoStorage, dynamoTableDefinition } from '../../src/dynamodb/index'
import { runStorageContract } from '../contract/storage-contract'

let container: StartedTestContainer
let client: DynamoDBClient
let storage: DynamoStorage

const commands = { PutItemCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand }

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
  await client.send(new CreateTableCommand(dynamoTableDefinition() as never))
  storage = new DynamoStorage(client, commands)
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
