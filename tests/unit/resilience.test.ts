import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { FencingError, Idempotency, StorageUnavailableError } from '../../src/index'
import type { IdempotencyEvent, IdempotencyStorage } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

function gate () {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

function instance (overrides: Partial<ConstructorParameters<typeof Idempotency>[0]> = {}) {
  return new Idempotency({ storage: new MemoryStorage(), ...overrides })
}

describe('N-way concurrency race', () => {
  test('50 parallel executes for one key run the function exactly once', async () => {
    const idempotency = instance({ onConflict: 'wait' })
    let calls = 0
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        idempotency.execute('k', async () => {
          calls += 1
          await sleep(20)
          return 'winner'
        })
      )
    )
    assert.equal(calls, 1)
    assert.equal(results.length, 50)
    assert.ok(results.every((result) => result === 'winner'))
  })

  test('50 parallel executes across 10 keys run each key exactly once', async () => {
    const idempotency = instance({ onConflict: 'wait' })
    const calls = new Map<string, number>()
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const key = `k${index % 10}`
        return idempotency.execute(key, async () => {
          calls.set(key, (calls.get(key) ?? 0) + 1)
          await sleep(10)
          return key
        })
      })
    )
    assert.equal(calls.size, 10)
    assert.ok([...calls.values()].every((count) => count === 1))
    results.forEach((result, index) => assert.equal(result, `k${index % 10}`))
  })
})

describe('crash recovery', () => {
  test('a key blocked by a crashed holder unblocks after lockTtl', async () => {
    const idempotency = instance({ lockTtl: '40ms' })
    const never = new Promise<string>(() => {})
    const crashed = idempotency.execute('k', async () => never)
    crashed.catch(() => {})
    await sleep(60)
    assert.equal(await idempotency.execute('k', async () => 'recovered'), 'recovered')
  })
})

describe('split-brain fencing', () => {
  test('a holder that lost its lock cannot overwrite the new holder result', async () => {
    const idempotency = instance({ lockTtl: '40ms' })
    const { open, opened } = gate()

    const staleHolder = idempotency.execute('k', async () => {
      await opened
      return 'stale'
    })
    staleHolder.catch(() => {})

    await sleep(60)
    assert.equal(await idempotency.execute('k', async () => 'fresh'), 'fresh')

    open()
    await assert.rejects(staleHolder, (error: unknown) => {
      assert.ok(error instanceof FencingError)
      assert.equal(error.code, 'IDEMPOTENCY_FENCING')
      return true
    })

    const record = await idempotency.get('k')
    assert.ok(record)
    assert.equal(record.value, 'fresh')
  })
})

describe('onStorageError policies', () => {
  const down: IdempotencyStorage = {
    acquire: async () => { throw new Error('connection refused') },
    complete: async () => { throw new Error('connection refused') },
    release: async () => { throw new Error('connection refused') },
    extend: async () => { throw new Error('connection refused') },
    get: async () => { throw new Error('connection refused') },
    delete: async () => { throw new Error('connection refused') }
  }

  test('closed (default) refuses to run without the guarantee', async () => {
    const idempotency = new Idempotency({ storage: down })
    let calls = 0
    await assert.rejects(
      idempotency.execute('k', async () => { calls += 1; return 'v' }),
      StorageUnavailableError
    )
    assert.equal(calls, 0)
  })

  test('open executes without the guarantee and emits storage-bypass', async () => {
    const events: IdempotencyEvent[] = []
    const idempotency = new Idempotency({
      storage: down,
      onStorageError: 'open',
      onEvent: (event) => events.push(event)
    })
    let calls = 0
    const fn = async () => { calls += 1; return 'v' }
    assert.equal(await idempotency.execute('k', fn), 'v')
    assert.equal(await idempotency.execute('k', fn), 'v')
    assert.equal(calls, 2)
    assert.deepEqual(events.map((event) => event.type), ['storage-bypass', 'storage-bypass'])
  })

  test('open returns the result when only the completion write fails', async () => {
    const memory = new MemoryStorage()
    const flaky: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: async () => { throw new Error('connection reset') },
      release: (key, token) => memory.release(key, token),
      extend: (key, token, lockTtlMs) => memory.extend(key, token, lockTtlMs),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const events: string[] = []
    const idempotency = new Idempotency({
      storage: flaky,
      onStorageError: 'open',
      onEvent: (event) => events.push(event.type)
    })
    assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
    assert.deepEqual(events, ['acquired', 'storage-bypass'])
  })

  test('closed surfaces a completion write failure after the function ran', async () => {
    const memory = new MemoryStorage()
    const flaky: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: async () => { throw new Error('connection reset') },
      release: (key, token) => memory.release(key, token),
      extend: (key, token, lockTtlMs) => memory.extend(key, token, lockTtlMs),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const idempotency = new Idempotency({ storage: flaky })
    await assert.rejects(idempotency.execute('k', async () => 'v'), StorageUnavailableError)
  })
})
