// Deterministic timing through the clock seam: exact durations, exact
// backoff sequences and exact expiry boundaries, no wall-clock races.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { Idempotency, WaitTimeoutError } from '../../src/index'
import type { IdempotencyEvent, IdempotencyStorage, StoredRecord } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { ManualClock } from '../helpers/manual-clock'

describe('durations through the clock seam', () => {
  test('terminal events measure the exact execution duration', async () => {
    const clock = new ManualClock(1_000)
    const events: IdempotencyEvent[] = []
    const idempotency = new Idempotency({
      storage: new MemoryStorage({ now: () => clock.now() }),
      clock,
      onEvent: (event) => events.push(event)
    })

    await idempotency.execute('k', async () => {
      clock.advance(500)
      return 'v'
    })
    const completed = events.find((event) => event.type === 'completed')
    assert.equal(completed?.durationMs, 500)

    await idempotency.execute('k', async () => 'never')
    const replayed = events.find((event) => event.type === 'replayed')
    assert.equal(replayed?.durationMs, 0)

    await assert.rejects(idempotency.execute('fails', async () => {
      clock.advance(120)
      throw new Error('x')
    }))
    const failed = events.find((event) => event.type === 'failed')
    assert.equal(failed?.durationMs, 120)
  })

  test('a persisted-failure replay measures the acquire round-trip exactly', async () => {
    const clock = new ManualClock(3_000)
    const memory = new MemoryStorage({ now: () => clock.now() })
    const storage: IdempotencyStorage = {
      acquire: async (record, ttl) => { clock.advance(35); return memory.acquire(record, ttl) },
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const events: IdempotencyEvent[] = []
    const idempotency = new Idempotency({ storage, clock, persistFailures: true, onEvent: (event) => events.push(event) })

    await assert.rejects(idempotency.execute('k', async () => { throw new Error('boom') }), /boom/)
    await assert.rejects(idempotency.execute('k', async () => 'never'), /boom/)
    const replayed = events.find((event) => event.type === 'replayed')
    assert.equal(replayed?.durationMs, 35)
  })

  test('unstorable results and completion-write failures measure their duration exactly', async () => {
    const clock = new ManualClock(4_000)
    const events: IdempotencyEvent[] = []
    const unstorable = new Idempotency({
      storage: new MemoryStorage({ now: () => clock.now() }),
      clock,
      onEvent: (event) => events.push(event)
    })
    await assert.rejects(unstorable.execute('k', async () => {
      clock.advance(90)
      return { big: 10n }
    }))
    const failed = events.find((event) => event.type === 'failed')
    assert.equal(failed?.durationMs, 90)

    const memory = new MemoryStorage({ now: () => clock.now() })
    const writeEvents: IdempotencyEvent[] = []
    const brokenWrite: IdempotencyStorage = {
      acquire: (record, ttl) => memory.acquire(record, ttl),
      complete: async () => { clock.advance(15); throw new Error('write lost') },
      release: (key, token) => memory.release(key, token),
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const failClosed = new Idempotency({ storage: brokenWrite, clock, onEvent: (event) => writeEvents.push(event) })
    await assert.rejects(failClosed.execute('k', async () => {
      clock.advance(40)
      return 'v'
    }))
    const writeFailed = writeEvents.find((event) => event.type === 'failed')
    assert.equal(writeFailed?.durationMs, 55)
  })

  test('acquired and conflict events carry no duration and no namespace by default', async () => {
    const events: IdempotencyEvent[] = []
    const idempotency = new Idempotency({ storage: new MemoryStorage(), onEvent: (event) => events.push(event) })
    await idempotency.execute('k', async () => 'v')
    const acquired = events.find((event) => event.type === 'acquired')
    assert.ok(acquired)
    assert.ok(!('durationMs' in acquired))
    assert.ok(!('namespace' in acquired))
  })
})

describe('the wait loop under a manual clock', () => {
  function inProgressRecord (clock: ManualClock): StoredRecord {
    return {
      key: 'k',
      token: 'holder',
      status: 'in-progress',
      storedAt: clock.now(),
      expiresAt: clock.now() + 60_000
    }
  }

  test('waiters back off 25, 50, 100... capped by the remaining budget, then time out', async () => {
    const clock = new ManualClock()
    let gets = 0
    const record = inProgressRecord(clock)
    const storage: IdempotencyStorage = {
      acquire: async () => record,
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => { gets += 1; return record },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait', waitTimeout: 200 })

    await assert.rejects(idempotency.execute('k', async () => 'never'), WaitTimeoutError)
    assert.deepEqual(clock.sleeps, [25, 50, 100, 25])
    assert.equal(gets, 5)
  })

  test('a waiter replays the exact moment the record completes', async () => {
    const clock = new ManualClock(2_000)
    const events: IdempotencyEvent[] = []
    let reads = 0
    const storage: IdempotencyStorage = {
      acquire: async () => ({ ...inProgressRecord(clock), token: 'winner' }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads += 1
        if (reads < 3) return { ...inProgressRecord(clock), token: 'winner' }
        return {
          key: 'k',
          token: 'winner',
          status: 'completed',
          result: '"done"',
          storedAt: 2_000,
          expiresAt: clock.now() + 60_000
        }
      },
      delete: async () => {}
    }
    const idempotency = new Idempotency({
      storage,
      clock,
      onConflict: 'wait',
      onEvent: (event) => events.push(event)
    })

    const outcome = await idempotency.executeWithMetadata('k', async () => 'never')
    assert.equal(outcome.value, 'done')
    assert.deepEqual(clock.sleeps, [25, 50])
    const replayed = events.find((event) => event.type === 'replayed')
    assert.equal(replayed?.durationMs, 75)
  })

  test('a waiter replaying a persisted failure measures the blocked window exactly', async () => {
    const clock = new ManualClock(5_000)
    const events: IdempotencyEvent[] = []
    const storage: IdempotencyStorage = {
      acquire: async () => ({ ...inProgressRecord(clock), token: 'winner' }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        clock.advance(40)
        return {
          key: 'k',
          token: 'winner',
          status: 'failed',
          error: JSON.stringify({ name: 'Error', message: 'stored boom' }),
          storedAt: 5_000,
          expiresAt: clock.now() + 60_000
        }
      },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait', onEvent: (event) => events.push(event) })

    await assert.rejects(idempotency.execute('k', async () => 'never'), /stored boom/)
    const replayed = events.find((event) => event.type === 'replayed')
    assert.equal(replayed?.durationMs, 40)
    assert.deepEqual(clock.sleeps, [], 'the first poll already found the outcome')
  })

  test('a working notification channel replaces the polling sleeps entirely', async () => {
    const clock = new ManualClock()
    let notifies = 0
    let reads = 0
    const storage: IdempotencyStorage = {
      acquire: async () => inProgressRecord(clock),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads += 1
        if (reads < 3) return inProgressRecord(clock)
        return { key: 'k', token: 'holder', status: 'completed', result: '"done"', storedAt: clock.now(), expiresAt: clock.now() + 60_000 }
      },
      delete: async () => {},
      waitForChange: async () => { notifies += 1; clock.advance(5) }
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait' })

    assert.equal(await idempotency.execute('k', async () => 'never'), 'done')
    assert.equal(notifies, 2)
    assert.deepEqual(clock.sleeps, [], 'a successful wake-up never falls back to polling')
  })

  test('a rejecting notification channel degrades to the polling sleeps', async () => {
    const clock = new ManualClock()
    let reads = 0
    const storage: IdempotencyStorage = {
      acquire: async () => inProgressRecord(clock),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads += 1
        if (reads < 3) return inProgressRecord(clock)
        return { key: 'k', token: 'holder', status: 'completed', result: '"done"', storedAt: clock.now(), expiresAt: clock.now() + 60_000 }
      },
      delete: async () => {},
      waitForChange: async () => { throw new Error('channel broken') }
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait' })

    assert.equal(await idempotency.execute('k', async () => 'never'), 'done')
    assert.deepEqual(clock.sleeps, [25, 50])
  })
})

describe('expiry boundaries under a manual clock', () => {
  test('a record is present one instant before expiry and absent at the boundary', async () => {
    const clock = new ManualClock(10_000)
    const storage = new MemoryStorage({ now: () => clock.now() })
    await storage.acquire({ key: 'k', token: 't', storedAt: clock.now() }, 100)

    clock.advance(99)
    assert.ok(await storage.get('k'), 'one millisecond before expiry the record is visible')
    clock.advance(1)
    assert.equal(await storage.get('k'), null, 'at the expiry instant the record reads as absent')
  })
})

describe('listener failures surface as process warnings', () => {
  async function warningsDuring (work: () => Promise<void>): Promise<string[]> {
    const seen: string[] = []
    const capture = (warning: Error): void => { seen.push(warning.message) }
    process.on('warning', capture)
    try {
      await work()
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', capture)
    }
    return seen
  }

  test('a throwing listener emits a warning naming the event type', async () => {
    const warnings = await warningsDuring(async () => {
      const idempotency = new Idempotency({
        storage: new MemoryStorage(),
        onEvent: () => { throw new Error('listener bug') }
      })
      await idempotency.execute('k', async () => 'v')
    })
    assert.ok(warnings.some((message) => message.includes('listener failed') && message.includes('listener bug')))
    assert.ok(warnings.some((message) => message.includes('acquired')))
  })

  test('healthy executions emit no warnings, with or without listeners', async () => {
    const warnings = await warningsDuring(async () => {
      const bare = new Idempotency({ storage: new MemoryStorage() })
      await bare.execute('k', async () => 'v')

      // A collector without a handler for some events must stay silent too.
      const partial = new Idempotency({
        storage: new MemoryStorage(),
        metrics: { onCompleted: () => {} }
      })
      await partial.execute('k', async () => 'v')
    })
    assert.deepEqual(warnings, [])
  })
})
