import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import pg from 'pg'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { Idempotency } from '../../src/index'
import { PostgresStorage } from '../../src/postgres/index'
import { runStorageContract } from '../contract/storage-contract'

let container: StartedTestContainer
let pool: pg.Pool
let storage: PostgresStorage

before(async () => {
  container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'quayside', POSTGRES_DB: 'quayside' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start()
  pool = new pg.Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: 'postgres',
    password: 'quayside',
    database: 'quayside'
  })
  storage = new PostgresStorage(pool)
  await storage.migrate()
})

after(async () => {
  await pool.end()
  await container.stop()
})

runStorageContract('PostgresStorage', async () => {
  await pool.query('DELETE FROM quayside_records')
  return storage
})

describe('PostgresStorage under fire', () => {
  test('50 parallel executes for one key run the function exactly once', async () => {
    await pool.query('DELETE FROM quayside_records')
    const idempotency = new Idempotency({ storage, onConflict: 'wait' })
    let calls = 0
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        idempotency.execute('race-key', async () => {
          calls += 1
          await sleep(30)
          return 'winner'
        })
      )
    )
    assert.equal(calls, 1)
    assert.ok(results.every((result) => result === 'winner'))
  })

  test('a crashed holder unblocks the key after its lock expires', async () => {
    await pool.query('DELETE FROM quayside_records')
    await storage.acquire({ key: 'crash-key', token: 'dead-holder', storedAt: Date.now() }, 400)
    const idempotency = new Idempotency({ storage, onConflict: 'wait', waitTimeout: '10s' })
    const started = Date.now()
    const value = await idempotency.execute('crash-key', async () => 'recovered')
    assert.equal(value, 'recovered')
    assert.ok(Date.now() - started >= 200, 'expected to wait for the stale lock')
  })

  test('sweep removes expired rows in bulk', async () => {
    await pool.query('DELETE FROM quayside_records')
    await storage.acquire({ key: 'expired-1', token: 't1', storedAt: Date.now() }, 30)
    await storage.acquire({ key: 'expired-2', token: 't2', storedAt: Date.now() }, 30)
    await storage.acquire({ key: 'alive', token: 't3', storedAt: Date.now() }, 60_000)
    await sleep(50)
    assert.equal(await storage.sweep(), 2)
    const remaining = await pool.query('SELECT record_key FROM quayside_records')
    assert.deepEqual(remaining.rows, [{ record_key: 'alive' }])
  })

  test('a custom table name is honored end to end', async () => {
    const custom = new PostgresStorage(pool, { tableName: 'quayside_custom' })
    await custom.migrate()
    const idempotency = new Idempotency({ storage: custom })
    assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
    assert.equal(await idempotency.execute('k', async () => 'other'), 'v')
    const rows = await pool.query('SELECT record_key FROM quayside_custom')
    assert.equal(rows.rowCount, 1)
  })
})
