import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import mysql from 'mysql2/promise'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { Idempotency } from '../../src/index'
import { MysqlStorage } from '../../src/mysql/index'
import { runStorageContract } from '../contract/storage-contract'

let container: StartedTestContainer
let pool: mysql.Pool
let storage: MysqlStorage

before(async () => {
  container = await new GenericContainer('mysql:8.4')
    .withEnvironment({ MYSQL_ROOT_PASSWORD: 'quayside', MYSQL_DATABASE: 'quayside' })
    .withExposedPorts(3306)
    // The init phase logs "ready for connections" for its temporary
    // socket-only server; a TCP ping only answers once the real server is
    // up, so the health check is the reliable readiness signal.
    .withHealthCheck({
      test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-pquayside'],
      interval: 1_000,
      timeout: 3_000,
      retries: 60
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(180_000)
    .start()
  pool = mysql.createPool({
    host: container.getHost(),
    port: container.getMappedPort(3306),
    user: 'root',
    password: 'quayside',
    database: 'quayside',
    connectionLimit: 10
  })
  storage = new MysqlStorage(pool)
  await storage.migrate()
})

after(async () => {
  await pool.end()
  await container.stop()
})

runStorageContract('MysqlStorage', async () => {
  await pool.query('DELETE FROM quayside_records')
  return storage
})

describe('MysqlStorage under fire', () => {
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
    const [rows] = await pool.query('SELECT record_key FROM quayside_records')
    assert.deepEqual(rows, [{ record_key: 'alive' }])
  })

  test('same-millisecond double extend stays a no-op success', async () => {
    await pool.query('DELETE FROM quayside_records')
    await storage.acquire({ key: 'hb', token: 'holder', storedAt: Date.now() }, 5_000)
    await storage.extend('hb', 'holder', 5_000)
    await storage.extend('hb', 'holder', 5_000)
    const record = await storage.get('hb')
    assert.ok(record)
    assert.equal(record.token, 'holder')
  })
})
