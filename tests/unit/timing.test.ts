// Deterministic timing through the clock seam: exact durations, exact
// backoff sequences and exact expiry boundaries, no wall-clock races.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { Idempotency, WaitTimeoutError } from '../../src/index'
import type { IdempotencyEvent, IdempotencyStorage, StoredRecord } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { ManualClock } from '../helpers/manual-clock'
import { warningsDuring } from '../helpers/warnings'

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

  test('waitTimeout bounds the whole call, not each wait after a takeover', async () => {
    // A waiter whose holder vanishes takes over; losing the re-acquire
    // race lands it in a new wait. Restarting the deadline there would let
    // sustained holder churn block one execute() forever while the
    // documented upper bound never fired.
    const clock = new ManualClock()
    const started = clock.now()
    let acquires = 0
    const churning: IdempotencyStorage = {
      // Every acquire loses to a fresh holder and every poll finds the
      // record gone, so the waiter cycles takeover -> conflict -> wait.
      // Each storage round trip costs a millisecond, as real I/O does.
      acquire: async () => {
        acquires += 1
        clock.advance(1)
        return { token: `holder-${acquires}`, status: 'in-progress', storedAt: clock.now(), expiresAt: clock.now() + 60_000 }
      },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => { clock.advance(1); return null },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: churning, clock, onConflict: 'wait', waitTimeout: 200 })

    await assert.rejects(
      idempotency.execute('churn', async () => 'never'),
      WaitTimeoutError,
      'the cumulative wait is bounded even though every takeover restarts the loop'
    )
    // The budget covers the whole call: a per-wait deadline would have let
    // these cycles run forever, and the cycle itself cannot spin free of it.
    assert.ok(clock.now() - started <= 200 + 25, `the call outlived its budget by ${clock.now() - started - 200}ms`)
    assert.ok(acquires > 1, 'the waiter really did take over more than once')
  })

  test('a takeover exactly at the deadline times out instead of running one more cycle', async () => {
    // The budget is spent, not nearly spent: taking over here would start
    // an execution the caller already stopped waiting for.
    const clock = new ManualClock()
    let acquires = 0
    const storage: IdempotencyStorage = {
      acquire: async () => {
        acquires += 1
        return { token: 'holder', status: 'in-progress', storedAt: clock.now(), expiresAt: clock.now() + 60_000 }
      },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      // The poll consumes exactly the whole budget and finds the record gone.
      get: async () => { clock.advance(100); return null },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait', waitTimeout: 100 })

    await assert.rejects(idempotency.execute('boundary', async () => 'never'), WaitTimeoutError)
    assert.equal(acquires, 1, 'no takeover was attempted once the budget was exactly spent')
  })

  test('a lock observed exactly at its expiry boundary recovers as expired', async () => {
    // The storages treat expiresAt <= now as expired, so the engine has to
    // agree at the boundary: a record last seen with expiresAt equal to the
    // clock is an expiry, not a deliberate release.
    const clock = new ManualClock(9_000)
    const events: string[] = []
    let acquires = 0
    const storage: IdempotencyStorage = {
      acquire: async () => {
        acquires += 1
        if (acquires > 1) return null
        return { token: 'holder', status: 'in-progress', storedAt: clock.now() - 100, expiresAt: clock.now() }
      },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, clock, onConflict: 'wait', onEvent: (event) => events.push(event.type) })

    assert.equal(await idempotency.execute('k', async () => 'recovered'), 'recovered')
    assert.ok(events.includes('expired-recovery'), 'expiresAt equal to now is an expiry, not a hand-off')
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

  function pollingStorage (clock: ManualClock, reads: { count: number }, waitForChange?: unknown): IdempotencyStorage {
    return {
      acquire: async () => inProgressRecord(clock),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads.count += 1
        if (reads.count < 3) return inProgressRecord(clock)
        return { key: 'k', token: 'holder', status: 'completed', result: '"done"', storedAt: clock.now(), expiresAt: clock.now() + 60_000 }
      },
      delete: async () => {},
      waitForChange
    } as unknown as IdempotencyStorage
  }

  test('a broken notification channel polls instead, and says so once', async () => {
    // The channel is a public extension point: a plain-JS adapter can throw
    // synchronously (a not-connected guard) or hand back something that is
    // not a promise at all. Neither may escape as the caller's failure, and
    // neither may pass for an instant wake-up that spins the loop.
    for (const broken of [
      () => { throw new Error('not connected') },
      () => undefined,
      async () => { throw new Error('subscriber down') }
    ]) {
      const clock = new ManualClock()
      const reads = { count: 0 }
      const idempotency = new Idempotency({
        storage: pollingStorage(clock, reads, broken),
        clock,
        onConflict: 'wait'
      })
      const warnings = await warningsDuring(async () => {
        assert.equal(await idempotency.execute('k', async () => 'never'), 'done')
      })
      assert.deepEqual(clock.sleeps, [25, 50], 'every failed wake-up fell back to a polling pause')
      assert.equal(warnings.length, 1, 'the broken channel is reported once per wait, not once per poll')
      assert.match(warnings[0] ?? '', /notification channel failed for "k"/)
    }
  })

  test('a storage without a notification channel polls silently', async () => {
    const clock = new ManualClock()
    const reads = { count: 0 }
    const idempotency = new Idempotency({ storage: pollingStorage(clock, reads), clock, onConflict: 'wait' })
    const warnings = await warningsDuring(async () => {
      assert.equal(await idempotency.execute('k', async () => 'never'), 'done')
    })
    assert.deepEqual(clock.sleeps, [25, 50])
    assert.deepEqual(warnings, [], 'not offering a channel is not a failure')
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
