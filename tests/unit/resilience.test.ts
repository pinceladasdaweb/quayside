import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { FencingError, Idempotency, StorageCorruptError, StorageUnavailableError } from '../../src/index'
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

  test('a corrupt record is never mistaken for an outage, in either policy', async () => {
    // Fail-open trades the guarantee for availability during an OUTAGE. A
    // record the contract cannot describe is a data bug on a healthy
    // storage, and it decodes the same way on every attempt: treating it
    // as an outage would run every request for that key unguarded until
    // the record expired.
    const corrupt: IdempotencyStorage = {
      acquire: async (record) => { throw new StorageCorruptError(record.key, 'corrupt idempotency record') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    for (const policy of ['closed', 'open'] as const) {
      let calls = 0
      const idempotency = new Idempotency({ storage: corrupt, onStorageError: policy })
      await assert.rejects(
        idempotency.execute('k', async () => { calls += 1; return 'v' }),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptError, `${policy} must surface the corruption`)
          assert.equal(error.code, 'IDEMPOTENCY_STORAGE_CORRUPT')
          assert.equal(error.key, 'k')
          return true
        }
      )
      assert.equal(calls, 0, `${policy} must not run unguarded on a data bug`)
    }
  })

  test('open covers a storage that dies while a waiter is polling', async () => {
    // The acquire path and the wait path take the same trade-off: an
    // instance that chose availability must not answer an outage with an
    // error just because it happened to be waiting when it hit.
    const memory = new MemoryStorage()
    let polls = 0
    const diesWhileWaiting: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: (key, token, lockTtlMs) => memory.extend(key, token, lockTtlMs),
      get: async (key) => {
        polls += 1
        if (polls > 1) throw new Error('connection lost mid-wait')
        return memory.get(key)
      },
      delete: (key) => memory.delete(key)
    }
    const events: string[] = []
    const idempotency = new Idempotency({
      storage: diesWhileWaiting,
      onConflict: 'wait',
      onStorageError: 'open',
      onEvent: (event) => events.push(event.type)
    })
    const { open, opened } = gate()
    const holder = idempotency.execute('k-wait', async () => { await opened; return 'winner' })
    await new Promise((resolve) => setImmediate(resolve))
    const waiter = idempotency.execute('k-wait', async () => 'unguarded')

    assert.equal(await waiter, 'unguarded', 'the waiter ran instead of surfacing a 503')
    assert.ok(events.includes('storage-bypass'), 'and the bypass is observable')
    open()
    assert.equal(await holder, 'winner')
  })

  test('closed still surfaces a storage that dies while a waiter is polling', async () => {
    const memory = new MemoryStorage()
    let polls = 0
    const diesWhileWaiting: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: (key, token, lockTtlMs) => memory.extend(key, token, lockTtlMs),
      get: async (key) => {
        polls += 1
        if (polls > 1) throw new Error('connection lost mid-wait')
        return memory.get(key)
      },
      delete: (key) => memory.delete(key)
    }
    const idempotency = new Idempotency({ storage: diesWhileWaiting, onConflict: 'wait' })
    const { open, opened } = gate()
    const holder = idempotency.execute('k-closed', async () => { await opened; return 'winner' })
    await new Promise((resolve) => setImmediate(resolve))
    let ran = false
    await assert.rejects(
      idempotency.execute('k-closed', async () => { ran = true; return 'never' }),
      StorageUnavailableError,
      'fail-closed refuses to run when the poll cannot reach the storage'
    )
    assert.equal(ran, false)
    open()
    assert.equal(await holder, 'winner')
  })

  test('a corrupt record found mid-wait is surfaced even under fail-open', async () => {
    // Availability is traded for outages, not for data bugs: the record
    // decodes the same way on the next poll too.
    const memory = new MemoryStorage()
    let polls = 0
    const corruptMidWait: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: (key, token, lockTtlMs) => memory.extend(key, token, lockTtlMs),
      get: async (key) => {
        polls += 1
        if (polls > 1) throw new StorageCorruptError(key, 'corrupt idempotency record')
        return memory.get(key)
      },
      delete: (key) => memory.delete(key)
    }
    const idempotency = new Idempotency({
      storage: corruptMidWait,
      onConflict: 'wait',
      onStorageError: 'open'
    })
    const { open, opened } = gate()
    const holder = idempotency.execute('k-corrupt', async () => { await opened; return 'winner' })
    await new Promise((resolve) => setImmediate(resolve))
    let ran = false
    await assert.rejects(
      idempotency.execute('k-corrupt', async () => { ran = true; return 'never' }),
      StorageCorruptError
    )
    assert.equal(ran, false, 'a data bug must not be answered by running unguarded')
    open()
    assert.equal(await holder, 'winner')
  })

  test('open covers a storage that dies during a heartbeat', async () => {
    const memory = new MemoryStorage()
    const noExtend: IdempotencyStorage = {
      acquire: (record, lockTtlMs) => memory.acquire(record, lockTtlMs),
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: async () => { throw new Error('connection lost') },
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const events: string[] = []
    const idempotency = new Idempotency({
      storage: noExtend,
      onStorageError: 'open',
      onEvent: (event) => events.push(event.type)
    })
    // A heartbeat that cannot reach the storage must not abort a function
    // this instance already chose to keep running.
    assert.equal(await idempotency.execute('k-beat', async (ctx) => {
      await ctx.extend('30s')
      return 'finished'
    }), 'finished')
    assert.ok(events.includes('storage-bypass'))

    const strict = new Idempotency({ storage: noExtend })
    await assert.rejects(
      strict.execute('k-beat-closed', async (ctx) => { await ctx.extend('30s'); return 'never' }),
      StorageUnavailableError
    )
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
