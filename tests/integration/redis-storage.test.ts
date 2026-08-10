import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import RedisClient from '@pinceladasdaweb/redis'
import { Redis } from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'

import { Idempotency } from '../../src/index'
import { RedisStorage, type ManagedRedisClient } from '../../src/redis/index'
import { runStorageContract } from '../contract/storage-contract'

let container: StartedTestContainer
let host: string
let port: number
let client: Redis
let storage: RedisStorage
let managedClient: RedisClient
let managedStorage: RedisStorage

before(async () => {
  container = await new GenericContainer('redis:8-alpine')
    .withCommand(['redis-server', '--notify-keyspace-events', 'K$gx'])
    .withExposedPorts(6379)
    .start()
  host = container.getHost()
  port = container.getMappedPort(6379)
  client = new Redis({ host, port })
  storage = new RedisStorage(client)
  managedClient = new RedisClient({ host, port })
  await managedClient.connect()
  managedStorage = new RedisStorage(managedClient as unknown as ManagedRedisClient)
})

after(async () => {
  await storage.close()
  await managedStorage.close()
  client.disconnect()
  await managedClient.disconnect()
  await container.stop()
})

runStorageContract('RedisStorage (ioredis)', async () => {
  await client.flushdb()
  return storage
})

runStorageContract('RedisStorage (@pinceladasdaweb/redis)', async () => {
  await client.flushdb()
  return managedStorage
})

describe('RedisStorage under fire', () => {
  test('survives a server-side CLIENT KILL mid-execution', async () => {
    await client.flushdb()
    const idempotency = new Idempotency({ storage, lockTtl: '10s' })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })

    const running = idempotency.execute('kill-case', async () => {
      await gate
      return 'survived'
    })
    await sleep(100)

    const admin = new Redis({ host, port })
    const killed = await admin.call('CLIENT', 'KILL', 'TYPE', 'normal')
    assert.ok(Number(killed) >= 1)

    release()
    assert.equal(await running, 'survived')

    const replay = await idempotency.executeWithMetadata('kill-case', async () => 'never')
    assert.equal(replay.value, 'survived')
    assert.equal(replay.replayed, true)
    await admin.quit()
  })

  test('recovers after the holder process is killed with SIGKILL', async () => {
    await client.flushdb()
    const fixture = path.join(import.meta.dirname, 'fixtures', 'hold-lock.ts')
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, host, String(port), 'crash-key', '1500'],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    await new Promise<void>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('HELD')) resolve()
      })
      child.on('exit', (code) => {
        reject(new Error(`fixture exited early with code ${String(code)}`))
      })
    })
    child.kill('SIGKILL')

    const idempotency = new Idempotency({ storage, onConflict: 'wait', waitTimeout: '10s' })
    const started = Date.now()
    const value = await idempotency.execute('crash-key', async () => 'recovered')
    const elapsed = Date.now() - started

    assert.equal(value, 'recovered')
    // The key stayed blocked until the dead holder's lock expired.
    assert.ok(elapsed >= 300, `expected to wait for the stale lock, waited ${elapsed}ms`)
  })

  test('waitForChange wakes early on keyspace notifications', async () => {
    await client.flushdb()
    const writer = new Redis({ host, port })
    const started = Date.now()
    const waiting = storage.waitForChange('notify-key', 8_000)
    await sleep(150)
    await writer.set('notify-key', 'x')
    await waiting
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 100, `woke before the write (${elapsed}ms)`)
    assert.ok(elapsed < 6_000, `notification did not wake the waiter (${elapsed}ms)`)
    await writer.quit()
  })

  test('waitForChange resolves at the timeout when nothing changes', async () => {
    await client.flushdb()
    const started = Date.now()
    await storage.waitForChange('silent-key', 300)
    assert.ok(Date.now() - started >= 250)
  })

  test('a waiter replays the winner result across real connections', async () => {
    await client.flushdb()
    const idempotency = new Idempotency({ storage, onConflict: 'wait' })
    let calls = 0
    const winner = idempotency.execute('wait-key', async () => {
      calls += 1
      await sleep(300)
      return 'winner'
    })
    await sleep(50)
    const waiter = idempotency.execute('wait-key', async () => {
      calls += 1
      return 'loser'
    })
    assert.equal(await winner, 'winner')
    assert.equal(await waiter, 'winner')
    assert.equal(calls, 1)
  })

  test('the managed client waits through its dedicated pub/sub connection', async () => {
    await client.flushdb()
    const idempotency = new Idempotency({ storage: managedStorage, onConflict: 'wait' })
    let calls = 0
    const winner = idempotency.execute('managed-wait', async () => {
      calls += 1
      await sleep(200)
      return 'winner'
    })
    await sleep(50)
    const waiter = idempotency.execute('managed-wait', async () => {
      calls += 1
      return 'loser'
    })
    assert.equal(await winner, 'winner')
    assert.equal(await waiter, 'winner')
    assert.equal(calls, 1)
  })
})
