import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { hashCanonical } from '../../src/canonical'
import {
  ConcurrentExecutionError,
  FencingError,
  Idempotency,
  IdempotencyKeyReuseError,
  SerializationError,
  StorageUnavailableError,
  WaitTimeoutError
} from '../../src/index'
import type { IdempotencyEvent, IdempotencyStorage, StoredRecord } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { ManualClock } from '../helpers/manual-clock'
import { warningsDuring } from '../helpers/warnings'

function gate () {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

function instance (overrides: Partial<ConstructorParameters<typeof Idempotency>[0]> = {}) {
  return new Idempotency({ storage: new MemoryStorage(), ...overrides })
}

describe('Idempotency.execute', () => {
  test('executes the function once and replays the stored result', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => {
      calls += 1
      return { paymentId: 'p-1' }
    }
    const first = await idempotency.execute('invoice:123', fn)
    const second = await idempotency.execute('invoice:123', fn)
    assert.deepEqual(first, { paymentId: 'p-1' })
    assert.deepEqual(second, { paymentId: 'p-1' })
    assert.equal(calls, 1)
  })

  test('accepts the object input form', async () => {
    const idempotency = instance()
    const value = await idempotency.execute({ key: 'invoice:9' }, async () => 'ok')
    assert.equal(value, 'ok')
  })

  test('different keys execute independently', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    assert.equal(await idempotency.execute('a', fn), 1)
    assert.equal(await idempotency.execute('b', fn), 2)
  })

  test('namespaces isolate the same key on shared storage', async () => {
    const storage = new MemoryStorage()
    const payments = new Idempotency({ storage, namespace: 'payments' })
    const refunds = new Idempotency({ storage, namespace: 'refunds' })
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    assert.equal(await payments.execute('k', fn), 1)
    assert.equal(await refunds.execute('k', fn), 2)
  })

  test('replays undefined results', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1 }
    assert.equal(await idempotency.execute('k', fn), undefined)
    const replay = await idempotency.executeWithMetadata('k', fn)
    assert.equal(replay.value, undefined)
    assert.equal(replay.replayed, true)
    assert.equal(calls, 1)
  })

  test('rejects a non-empty key requirement violation', async () => {
    const idempotency = instance()
    await assert.rejects(idempotency.execute('', async () => 1), TypeError)
  })

  test('exposes key, replayed and an abort signal on the context', async () => {
    const idempotency = instance()
    await idempotency.execute('k', async (ctx) => {
      assert.equal(ctx.key, 'k')
      assert.equal(ctx.replayed, false)
      assert.ok(ctx.signal instanceof AbortSignal)
      await ctx.extend('1h')
      await ctx.extend() // defaults to the instance lockTtl
      return 1
    })
  })
})

describe('Idempotency concurrency', () => {
  test('onConflict reject throws ConcurrentExecutionError while in progress', async () => {
    const idempotency = instance()
    const { open, opened } = gate()
    const running = idempotency.execute('k', async () => {
      await opened
      return 'first'
    })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 'second'), (error: unknown) => {
      assert.ok(error instanceof ConcurrentExecutionError)
      assert.equal(error.code, 'IDEMPOTENCY_IN_PROGRESS')
      assert.equal(error.key, 'k')
      return true
    })
    open()
    assert.equal(await running, 'first')
  })

  test('onConflict wait returns the winner result without re-executing', async () => {
    const idempotency = instance({ onConflict: 'wait' })
    const { open, opened } = gate()
    let calls = 0
    const running = idempotency.execute('k', async () => {
      calls += 1
      await opened
      return 'winner'
    })
    await new Promise((resolve) => setImmediate(resolve))
    const waiting = idempotency.executeWithMetadata('k', async () => {
      calls += 1
      return 'loser'
    })
    setTimeout(open, 50)
    assert.equal(await running, 'winner')
    const replay = await waiting
    assert.equal(replay.value, 'winner')
    assert.equal(replay.replayed, true)
    assert.equal(calls, 1)
  })

  test('onConflict wait times out with WaitTimeoutError', async () => {
    const idempotency = instance({ onConflict: 'wait', waitTimeout: '80ms' })
    const { open, opened } = gate()
    const running = idempotency.execute('k', async () => {
      await opened
      return 'slow'
    })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 'x'), (error: unknown) => {
      assert.ok(error instanceof WaitTimeoutError)
      assert.equal(error.code, 'IDEMPOTENCY_WAIT_TIMEOUT')
      return true
    })
    open()
    await running
  })

  test('a waiter replays a persisted failure', async () => {
    const idempotency = instance({ onConflict: 'wait', persistFailures: true })
    const { open, opened } = gate()
    const failing = idempotency.execute('k', async () => {
      await opened
      throw new Error('holder exploded')
    })
    failing.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    const waiting = idempotency.execute('k', async () => 'never')
    setTimeout(open, 30)
    await assert.rejects(failing, /holder exploded/)
    await assert.rejects(waiting, /holder exploded/)
  })

  test('a storage with waitForChange drives the wait, and a broken one degrades to polling', async () => {
    const makeStorage = (waitForChange: (key: string, timeoutMs: number) => Promise<void>) => {
      const memory = new MemoryStorage()
      const storage: IdempotencyStorage = {
        acquire: (record, ttl) => memory.acquire(record, ttl),
        complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
        release: (key, token) => memory.release(key, token),
        extend: (key, token, ttl) => memory.extend(key, token, ttl),
        get: (key) => memory.get(key),
        delete: (key) => memory.delete(key),
        waitForChange
      }
      return storage
    }

    let waits = 0
    const notifying = new Idempotency({
      storage: makeStorage(async (_key, timeoutMs) => {
        waits += 1
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 10)))
      }),
      onConflict: 'wait'
    })
    const { open, opened } = gate()
    const winner = notifying.execute('k', async () => { await opened; return 'w' })
    await new Promise((resolve) => setImmediate(resolve))
    const waiter = notifying.execute('k', async () => 'l')
    setTimeout(open, 40)
    assert.equal(await winner, 'w')
    assert.equal(await waiter, 'w')
    assert.ok(waits >= 1, 'expected the waiter to use waitForChange')

    const broken = new Idempotency({
      storage: makeStorage(async () => { throw new Error('subscriber down') }),
      onConflict: 'wait'
    })
    const secondGate = gate()
    // The expected warning is captured so it does not land in the output.
    const warnings = await warningsDuring(async () => {
      const winner2 = broken.execute('k2', async () => { await secondGate.opened; return 'w2' })
      await new Promise((resolve) => setImmediate(resolve))
      const waiter2 = broken.execute('k2', async () => 'l2')
      setTimeout(secondGate.open, 40)
      assert.equal(await winner2, 'w2')
      assert.equal(await waiter2, 'w2')
    })
    assert.ok(warnings.some((message) => message.includes('notification channel failed')))
  })

  test('a waiter takes over after the holder fails, and that is not an expired recovery', async () => {
    const events: string[] = []
    const idempotency = instance({ onConflict: 'wait', onEvent: (event) => events.push(event.type) })
    const { open, opened } = gate()
    const failing = idempotency.execute('k', async () => {
      await opened
      throw new Error('holder exploded')
    })
    await new Promise((resolve) => setImmediate(resolve))
    const waiting = idempotency.executeWithMetadata('k', async () => 'recovered')
    setTimeout(open, 30)
    await assert.rejects(failing, /holder exploded/)
    const outcome = await waiting
    assert.equal(outcome.value, 'recovered')
    assert.equal(outcome.replayed, false)
    // The holder released its record deliberately; its lock never ran out.
    assert.ok(!events.includes('expired-recovery'), 'a failure release must not read as a lock expiry')
  })

  test('a waiter taking over an expired lock emits expired-recovery', async () => {
    const clock = new ManualClock()
    const events: string[] = []
    const idempotency = new Idempotency({
      storage: new MemoryStorage({ now: () => clock.now() }),
      clock,
      onConflict: 'wait',
      lockTtl: '1s',
      onEvent: (event) => events.push(event.type)
    })
    // A holder that stalls through its whole lease: the waiter's polling
    // sleeps drive the manual clock past the lock TTL, the record reads as
    // absent, and the takeover is a recovery, not a hand-off.
    const { open, opened } = gate()
    const stalled = idempotency.execute('k', async () => {
      await opened
      return 'late'
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await idempotency.execute('k', async () => 'recovered'), 'recovered')
    assert.equal(events.filter((type) => type === 'expired-recovery').length, 1)

    // The stalled holder wakes up to find it no longer owns the key: the
    // fencing token protects the recovered execution from its late write.
    open()
    await assert.rejects(stalled, FencingError)
  })
})

describe('Idempotency failures', () => {
  test('failures are not cached by default: the record is deleted and retries run', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls === 1) throw new Error('transient')
      return 'recovered'
    }
    await assert.rejects(idempotency.execute('k', fn), /transient/)
    assert.equal(await idempotency.execute('k', fn), 'recovered')
    assert.equal(calls, 2)
  })

  test('persistFailures replays the stored error without re-executing', async () => {
    const idempotency = instance({ persistFailures: true })
    let calls = 0
    const fn = async () => {
      calls += 1
      const error = new Error('card declined')
      error.name = 'PaymentDeclinedError'
      throw error
    }
    await assert.rejects(idempotency.execute('k', fn), /card declined/)
    await assert.rejects(idempotency.execute('k', fn), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'PaymentDeclinedError')
      assert.equal(error.message, 'card declined')
      return true
    })
    assert.equal(calls, 1)
  })

  test('replayed failures preserve own properties and the cause chain', async () => {
    const idempotency = instance({ persistFailures: true })
    const fn = async () => {
      const cause = new Error('insufficient funds')
      const error = new Error('card declined') as Error & { code: string, statusCode: number, skipped?: () => void }
      error.name = 'PaymentDeclinedError'
      error.code = 'CARD_DECLINED'
      error.statusCode = 402
      error.skipped = () => 1
      error.cause = cause
      throw error
    }
    await assert.rejects(idempotency.execute('k', fn), /card declined/)
    await assert.rejects(idempotency.execute('k', fn), (error: unknown) => {
      const replayed = error as Error & { code?: string, statusCode?: number, skipped?: unknown }
      assert.ok(replayed instanceof Error)
      assert.equal(replayed.name, 'PaymentDeclinedError')
      assert.equal(replayed.code, 'CARD_DECLINED')
      assert.equal(replayed.statusCode, 402)
      assert.equal(replayed.skipped, undefined)
      assert.ok(replayed.cause instanceof Error)
      assert.equal((replayed.cause as Error).message, 'insufficient funds')
      return true
    })
  })

  test('replays non-Error throws and survives hostile error shapes', async () => {
    const idempotency = instance({ persistFailures: true })
    // eslint-disable-next-line no-throw-literal -- non-Error throws are the case under test
    await assert.rejects(idempotency.execute('plain', async () => { throw 'just a string' }), /just a string/)
    await assert.rejects(idempotency.execute('plain', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'just a string')
      assert.equal(error.name, 'Error')
      assert.equal(typeof error.stack, 'string')
      return true
    })

    const unstringable = { toString () { throw new Error('nope') } }
    await assert.rejects(idempotency.execute('hostile', async () => { throw unstringable }))
    await assert.rejects(idempotency.execute('hostile', async () => 'never'), /unknown failure/)

    const poisoned = new Error('base')
    Object.defineProperty(poisoned, 'name', { get () { throw new Error('gotcha') } })
    await assert.rejects(idempotency.execute('poisoned', async () => { throw poisoned }))
    await assert.rejects(idempotency.execute('poisoned', async () => 'never'), /failure could not be serialized/)
  })

  test('a corrupt stored failure replays as a plain error with the raw text', async () => {
    const storage = new MemoryStorage()
    await storage.acquire({ key: 'corrupt', token: 't', storedAt: Date.now() }, 60_000)
    await storage.complete('corrupt', 't', { status: 'failed', error: 'not json {' }, 60_000)
    const idempotency = new Idempotency({ storage, persistFailures: true })
    await assert.rejects(idempotency.execute('corrupt', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'not json {')
      assert.equal(error.name, 'Error')
      assert.equal(typeof error.stack, 'string')
      return true
    })
  })

  test('a hand-written stack replays verbatim', async () => {
    const idempotency = instance({ persistFailures: true })
    const fn = async () => {
      const error = new Error('with custom stack')
      error.stack = 'CUSTOM-STACK-MARKER'
      throw error
    }
    await assert.rejects(idempotency.execute('k', fn))
    await assert.rejects(idempotency.execute('k', async () => 'never'), (error: unknown) => {
      assert.equal((error as Error).stack, 'CUSTOM-STACK-MARKER')
      return true
    })
  })

  test('the cause chain replays capped at its depth budget', async () => {
    const idempotency = instance({ persistFailures: true })
    const fn = async () => {
      let chained = new Error('depth-7')
      for (let depth = 6; depth >= 0; depth -= 1) {
        chained = new Error(`depth-${depth}`, { cause: chained })
      }
      throw chained
    }
    await assert.rejects(idempotency.execute('deep', fn))
    await assert.rejects(idempotency.execute('deep', async () => 'never'), (error: unknown) => {
      let length = 0
      let cursor: unknown = error
      while (cursor instanceof Error) {
        length += 1
        cursor = cursor.cause
      }
      // depth 0 plus MAX_CAUSE_DEPTH serialized causes
      assert.equal(length, 6)
      return true
    })
  })

  test('a circular cause terminates at the depth budget', async () => {
    const idempotency = instance({ persistFailures: true })
    const fn = async () => {
      const error = new Error('ouroboros')
      error.cause = error
      throw error
    }
    await assert.rejects(idempotency.execute('circular', fn))
    await assert.rejects(idempotency.execute('circular', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /ouroboros/)
      return true
    })
  })

  test('a failed record without a stored error still replays an Error', async () => {
    const failedRecord = {
      token: 't',
      status: 'failed' as const,
      storedAt: Date.now(),
      expiresAt: Date.now() + 60_000
    }
    const stub: IdempotencyStorage = {
      acquire: async () => failedRecord,
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => failedRecord,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: stub })
    await assert.rejects(idempotency.execute('k', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, '')
      return true
    })

    // The same shape observed by a waiter instead of at acquisition time.
    const inProgress = { ...failedRecord, status: 'in-progress' as const }
    const waiterStub: IdempotencyStorage = { ...stub, acquire: async () => inProgress }
    const waiting = new Idempotency({ storage: waiterStub, onConflict: 'wait' })
    await assert.rejects(waiting.execute('k', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, '')
      return true
    })
  })

  test('a completed record without a stored result replays undefined', async () => {
    const completedRecord = {
      token: 't',
      status: 'completed' as const,
      storedAt: Date.now(),
      expiresAt: Date.now() + 60_000
    }
    const stub: IdempotencyStorage = {
      acquire: async () => completedRecord,
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => completedRecord,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: stub })
    const outcome = await idempotency.executeWithMetadata('k', async () => 'never')
    assert.equal(outcome.replayed, true)
    assert.equal(outcome.value, undefined)
  })

  test('fail-open executions expose a no-op extend', async () => {
    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => { throw new Error('must not be called') },
      get: async () => null,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: down, onStorageError: 'open' })
    const value = await idempotency.execute('k', async (ctx) => {
      await ctx.extend('1m')
      return 'v'
    })
    assert.equal(value, 'v')
  })

  test('rejects non-string keys', async () => {
    const idempotency = instance()
    await assert.rejects(idempotency.execute(123 as never, async () => 1), TypeError)
    await assert.rejects(idempotency.execute({ key: 123 as never }, async () => 1), TypeError)
  })

  test('a non-serializable result surfaces SerializationError and releases the key', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls === 1) return { callback: () => 1 }
      return { ok: true }
    }
    await assert.rejects(idempotency.execute('k', fn), SerializationError)
    assert.deepEqual(await idempotency.execute('k', fn), { ok: true })
    assert.equal(calls, 2)
  })

  test('storage unavailability fails closed', async () => {
    const broken: IdempotencyStorage = {
      acquire: async () => { throw new Error('connection refused') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: broken })
    let calls = 0
    await assert.rejects(
      idempotency.execute('k', async () => { calls += 1; return 1 }),
      (error: unknown) => {
        assert.ok(error instanceof StorageUnavailableError)
        assert.equal(error.code, 'IDEMPOTENCY_STORAGE_UNAVAILABLE')
        return true
      }
    )
    assert.equal(calls, 0)
  })
})

describe('per-call resultTtl', () => {
  // A per-route replay window is a property of the call. Building a second
  // engine around the same storage to express it costs an allocation per
  // request and duplicates state the moment the engine ever holds any.
  test('the call overrides the instance window, and omitting it keeps the default', async () => {
    const clock = new ManualClock(1_000)
    const storage = new MemoryStorage({ now: () => clock.now() })
    const idempotency = new Idempotency({ storage, resultTtl: '1h', clock })

    await idempotency.execute({ key: 'short', resultTtl: '50ms' }, async () => 'v')
    await idempotency.execute({ key: 'default' }, async () => 'v')
    await idempotency.execute('bare-string', async () => 'v')

    clock.advance(51)
    assert.equal(await idempotency.get('short'), null, 'the per-call window closed')
    assert.ok(await idempotency.get('default'), 'the object form without a ttl keeps the instance window')
    assert.ok(await idempotency.get('bare-string'), 'the string form keeps it too')
  })

  test('it governs a persisted failure as well as a result', async () => {
    const clock = new ManualClock(2_000)
    const storage = new MemoryStorage({ now: () => clock.now() })
    const idempotency = new Idempotency({ storage, resultTtl: '1h', persistFailures: true, clock })

    await assert.rejects(
      idempotency.execute({ key: 'failed', resultTtl: '40ms' }, async () => { throw new Error('boom') }),
      /boom/
    )
    assert.equal((await idempotency.get('failed'))?.status, 'failed')

    clock.advance(41)
    assert.equal(await idempotency.get('failed'), null, 'the stored failure closed with the call window')
  })
})

describe('Idempotency API surface', () => {
  test('executeWithMetadata reports replay status and storedAt', async () => {
    const idempotency = instance()
    const first = await idempotency.executeWithMetadata('k', async () => 'v')
    const second = await idempotency.executeWithMetadata('k', async () => 'v')
    assert.equal(first.replayed, false)
    assert.equal(second.replayed, true)
    assert.equal(second.value, 'v')
    assert.equal(second.storedAt, first.storedAt)
  })

  test('wrap derives the key from the call arguments', async () => {
    const idempotency = instance()
    let calls = 0
    const createPayment = async (input: { invoiceId: number }) => {
      calls += 1
      return `payment-for-${input.invoiceId}`
    }
    const createOnce = idempotency.wrap(createPayment, {
      key: (input) => `payment:${input.invoiceId}`
    })
    assert.equal(await createOnce({ invoiceId: 123 }), 'payment-for-123')
    assert.equal(await createOnce({ invoiceId: 123 }), 'payment-for-123')
    assert.equal(await createOnce({ invoiceId: 456 }), 'payment-for-456')
    assert.equal(calls, 2)
  })

  test('get exposes a persisted failure as a decoded error', async () => {
    const idempotency = instance({ persistFailures: true })
    await assert.rejects(idempotency.execute('k', async () => { throw new Error('stored failure') }))
    const record = await idempotency.get('k')
    assert.ok(record)
    assert.equal(record.status, 'failed')
    assert.ok(record.error instanceof Error)
    assert.equal(record.error.message, 'stored failure')
    assert.ok(!('value' in record), 'a failed record exposes no value, not even undefined')
  })

  test('get exposes the decoded record and invalidate allows re-execution', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return { total: 10 } }
    await idempotency.execute('k', fn)

    const record = await idempotency.get('k')
    assert.ok(record)
    assert.equal(record.key, 'k')
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.value, { total: 10 })
    assert.ok(!('error' in record), 'a completed record exposes no error, not even undefined')

    await idempotency.invalidate('k')
    assert.equal(await idempotency.get('k'), null)
    await idempotency.execute('k', fn)
    assert.equal(calls, 2)
  })
})

describe('Idempotency observability', () => {
  test('emits acquired/completed then replayed with a stable correlationId per call', async () => {
    const events: IdempotencyEvent[] = []
    const idempotency = instance({ onEvent: (event) => events.push(event) })
    await idempotency.execute('k', async () => 1)
    await idempotency.execute('k', async () => 1)

    assert.deepEqual(events.map((event) => event.type), ['acquired', 'completed', 'replayed'])
    assert.ok(events.every((event) => event.key === 'k'))
    assert.equal(events[0]?.correlationId, events[1]?.correlationId)
    assert.notEqual(events[1]?.correlationId, events[2]?.correlationId)
  })

  test('emits conflict and failed events', async () => {
    const events: string[] = []
    const idempotency = instance({ onEvent: (event) => events.push(event.type) })
    const { open, opened } = gate()
    const running = idempotency.execute('k', async () => { await opened; return 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 2), ConcurrentExecutionError)
    open()
    await running
    await assert.rejects(idempotency.execute('fails', async () => { throw new Error('x') }), /x/)
    assert.deepEqual(events, ['acquired', 'conflict', 'completed', 'acquired', 'failed'])
  })

  test('routes events to the MetricsCollector and survives listener failures', async () => {
    const seen: string[] = []
    const idempotency = instance({
      onEvent: () => { throw new Error('listener bug') },
      metrics: {
        onAcquired: (event) => seen.push(`acquired:${event.key}`),
        onCompleted: (event) => seen.push(`completed:${event.key}`),
        onReplayed: (event) => seen.push(`replayed:${event.key}`)
      }
    })
    // The failures are expected: capturing them keeps the reported warnings
    // out of the test output.
    await warningsDuring(async () => {
      assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
      assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
    })
    assert.deepEqual(seen, ['acquired:k', 'completed:k', 'replayed:k'])
  })

  test('events carry the namespace when configured', async () => {
    const events: IdempotencyEvent[] = []
    const idempotency = instance({ namespace: 'payments', onEvent: (event) => events.push(event) })
    await idempotency.execute('k', async () => 1)
    assert.ok(events.every((event) => event.namespace === 'payments'))
  })
})

describe('doNotStore', () => {
  test('the value reaches the caller and nothing is left to replay', async () => {
    let runs = 0
    const idempotency = instance()
    const run = async () => idempotency.execute('k', async (ctx) => {
      runs += 1
      ctx.doNotStore()
      return `run-${runs}`
    })

    assert.equal(await run(), 'run-1')
    assert.equal(await idempotency.get('k'), null, 'the record is released, never completed')
    assert.equal(await run(), 'run-2', 'the next call executes fresh instead of replaying')
  })

  test('it overrides persistFailures for that run', async () => {
    let runs = 0
    const idempotency = instance({ persistFailures: true })
    await assert.rejects(idempotency.execute('k', async (ctx) => {
      runs += 1
      ctx.doNotStore()
      throw new Error('transient')
    }), /transient/)
    assert.equal(await idempotency.get('k'), null)

    // Without the opt-out the same instance does persist the failure.
    await assert.rejects(idempotency.execute('k', async () => { throw new Error('permanent') }), /permanent/)
    const record = await idempotency.get('k')
    assert.equal(record?.status, 'failed')
    assert.equal(runs, 1)
  })

  test('concurrent callers stay protected while it runs', async () => {
    const idempotency = instance()
    const { open, opened } = gate()
    const running = idempotency.execute('k', async (ctx) => {
      ctx.doNotStore()
      await opened
      return 'first'
    })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 'second'), ConcurrentExecutionError)
    open()
    assert.equal(await running, 'first')
  })

  test('it reports completion, its exact duration and a fresh result', async () => {
    const clock = new ManualClock(7_000)
    const events: IdempotencyEvent[] = []
    const idempotency = new Idempotency({
      storage: new MemoryStorage({ now: () => clock.now() }),
      clock,
      onEvent: (event) => events.push(event)
    })
    const outcome = await idempotency.executeWithMetadata('k', async (ctx) => {
      ctx.doNotStore()
      clock.advance(250)
      return 'v'
    })
    assert.equal(outcome.value, 'v')
    assert.equal(outcome.replayed, false, 'the caller ran the function itself')
    assert.equal(outcome.storedAt, 7_000)
    assert.deepEqual(events.map((event) => event.type), ['acquired', 'completed'])
    assert.equal(events[1]?.durationMs, 250)
  })

  test('fail-open executions accept the opt-out as a no-op', async () => {
    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const open = new Idempotency({ storage: down, onStorageError: 'open' })
    const value = await open.execute('k', async (ctx) => {
      ctx.doNotStore()
      return 'unguarded'
    })
    assert.equal(value, 'unguarded', 'nothing is stored either way, so the call changes nothing')
  })
})

describe('waiters and key identity', () => {
  test('a waiter refuses an outcome stored under a different payload', async () => {
    // The holder's lock expires mid-wait and another payload takes the key
    // over: its result belongs to that payload, not to the waiter's.
    let reads = 0
    const takeover = {
      token: 'other-holder',
      status: 'completed' as const,
      result: '"someone else\'s result"',
      // the canonical hash of a different payload
      fingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      storedAt: 1,
      expiresAt: Date.now() + 60_000
    }
    const storage: IdempotencyStorage = {
      acquire: async (record) => ({ ...takeover, status: 'in-progress', fingerprint: record.fingerprint, result: undefined }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads += 1
        return takeover
      },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, onConflict: 'wait' })
    await assert.rejects(
      idempotency.execute({ key: 'k', payload: { amount: 1 } }, async () => 'never'),
      IdempotencyKeyReuseError
    )
    assert.equal(reads, 1)
  })

  test('a waiter still replays an outcome stored under its own payload', async () => {
    let reads = 0
    const storage: IdempotencyStorage = {
      acquire: async (record) => ({
        token: 'holder',
        status: 'in-progress',
        fingerprint: record.fingerprint,
        storedAt: 1,
        expiresAt: Date.now() + 60_000
      }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => {
        reads += 1
        return {
          token: 'holder',
          status: 'completed' as const,
          result: '"winner"',
          fingerprint: hashCanonical({ amount: 1 }),
          storedAt: 1,
          expiresAt: Date.now() + 60_000
        }
      },
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, onConflict: 'wait' })
    assert.equal(await idempotency.execute({ key: 'k', payload: { amount: 1 } }, async () => 'never'), 'winner')
    assert.equal(reads, 1)
  })

  test('a keyless waiter tolerates an outcome with no fingerprint', async () => {
    const storage: IdempotencyStorage = {
      acquire: async () => ({ key: 'k', token: 'holder', status: 'in-progress', storedAt: 1, expiresAt: Date.now() + 60_000 }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => ({ key: 'k', token: 'holder', status: 'completed' as const, result: '"winner"', storedAt: 1, expiresAt: Date.now() + 60_000 }),
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage, onConflict: 'wait' })
    assert.equal(await idempotency.execute('k', async () => 'never'), 'winner')
  })
})

describe('persisted failures go through the codec', () => {
  // A codec exists so the caller decides what reaches the store. Results
  // honoured it and failures did not, so an encrypting codec left error
  // messages, stacks and properties in the clear beside ciphertext.
  function recordingCodec () {
    const encoded: unknown[] = []
    const codec = {
      encode (value: unknown) {
        encoded.push(value)
        return `enc:${JSON.stringify(value)}`
      },
      decode (raw: string) {
        if (!raw.startsWith('enc:')) throw new SerializationError('foreign payload')
        return JSON.parse(raw.slice(4))
      }
    }
    return { codec, encoded }
  }

  test('the stored failure is written and read back through the codec', async () => {
    const { codec, encoded } = recordingCodec()
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, codec, persistFailures: true })

    const boom = Object.assign(new Error('card declined'), { code: 'CARD_DECLINED' })
    await assert.rejects(idempotency.execute('k', async () => { throw boom }), /card declined/)

    const stored = await storage.get('k')
    assert.ok(stored?.error?.startsWith('enc:'), 'the codec owns the stored bytes, not JSON')
    const serialized = encoded.at(-1) as { name: string, message: string, properties: { code: string } }
    assert.equal(serialized.message, 'card declined', 'the codec receives the serialized shape, not a string')
    assert.equal(serialized.properties.code, 'CARD_DECLINED')

    const replayed = await idempotency.execute('k', async () => 'never').then(
      () => assert.fail('the persisted failure must replay'),
      (error: Error) => error
    )
    assert.equal(replayed.message, 'card declined')
    assert.equal((replayed as { code?: string }).code, 'CARD_DECLINED')
  })

  test('the default codec keeps the exact bytes earlier versions wrote', async () => {
    // Records written before failures went through the codec must still
    // replay: with jsonCodec the encoding has to stay byte-identical.
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, persistFailures: true })
    const boom = Object.assign(new Error('legacy'), { code: 'X' })
    await assert.rejects(idempotency.execute('k', async () => { throw boom }), /legacy/)

    const stored = await storage.get('k')
    const parsed = JSON.parse(stored?.error ?? '{}') as { name: string, message: string, properties: unknown, stack: string }
    assert.equal(parsed.name, 'Error')
    assert.equal(parsed.message, 'legacy')
    assert.deepEqual(parsed.properties, { code: 'X' })
    assert.ok(parsed.stack.includes('legacy'))
  })

  test('an error with no stack survives the default codec, which rejects undefined', async () => {
    // jsonCodec refuses nested undefined by design, so the serialized shape
    // must omit an absent stack rather than carry the key with no value:
    // otherwise every stackless failure would store the fallback marker.
    const idempotency = new Idempotency({ storage: new MemoryStorage(), persistFailures: true })
    const stackless = new Error('no stack here')
    delete (stackless as { stack?: string }).stack

    await assert.rejects(idempotency.execute('k', async () => { throw stackless }), /no stack here/)
    const replayed = await idempotency.execute('k', async () => 'never').then(
      () => assert.fail('the persisted failure must replay'),
      (error: Error) => error
    )
    assert.equal(replayed.message, 'no stack here', 'the real failure survived, not the fallback marker')
  })

  test('a codec that cannot encode the failure falls back instead of masking it', async () => {
    const hostile = {
      encode () { throw new Error('encoder exploded') },
      decode (raw: string) { return JSON.parse(raw) }
    }
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, codec: hostile, persistFailures: true })

    // The original failure reaches the caller; the store keeps a marker.
    await assert.rejects(idempotency.execute('k', async () => { throw new Error('the real problem') }), /the real problem/)
    const stored = await storage.get('k')
    assert.match(stored?.error ?? '', /could not be serialized/)
  })

  test('a record the codec cannot read replays with the raw text', async () => {
    const { codec } = recordingCodec()
    const storage = new MemoryStorage()
    await storage.acquire({ key: 'foreign', token: 't', storedAt: Date.now() }, 60_000)
    await storage.complete('foreign', 't', { status: 'failed', error: 'written by another codec' }, 60_000)

    const idempotency = new Idempotency({ storage, codec, persistFailures: true })
    const replayed = await idempotency.execute('foreign', async () => 'never').then(
      () => assert.fail('the stored failure must replay'),
      (error: Error) => error
    )
    assert.equal(replayed.message, 'written by another codec')
    assert.equal(replayed.name, 'Error')
  })

  test('a record decoding to a non-object replays with the raw text', async () => {
    const idempotency = (storage: MemoryStorage) => new Idempotency({ storage, persistFailures: true })
    // Both are valid JSON for the default codec, and neither is a
    // serialized error. `null` is the sharp one: typeof null is 'object',
    // so only an explicit check keeps it away from the reviver.
    const cases: Array<[string, string]> = [['scalar', '"just a string"'], ['nulled', 'null']]
    for (const [key, stored] of cases) {
      const storage = new MemoryStorage()
      await storage.acquire({ key, token: 't', storedAt: Date.now() }, 60_000)
      await storage.complete(key, 't', { status: 'failed', error: stored }, 60_000)

      const replayed = await idempotency(storage).execute(key, async () => 'never').then(
        () => assert.fail('the stored failure must replay'),
        (error: Error) => error
      )
      assert.equal(replayed.message, stored)
      assert.equal(replayed.name, 'Error')
    }
  })
})

describe('failure cleanup and revival edges', () => {
  test('a failed execution leaves no record behind: the retry runs fresh', async () => {
    let runs = 0
    const idempotency = instance()
    await assert.rejects(
      idempotency.execute('k', async () => { runs += 1; throw new Error('first attempt') }),
      /first attempt/
    )
    const value = await idempotency.execute('k', async () => { runs += 1; return 'second attempt' })
    assert.equal(value, 'second attempt')
    assert.equal(runs, 2)
  })

  test('an unstorable result releases the record even with persistFailures on', async () => {
    let runs = 0
    const idempotency = instance({ persistFailures: true })
    const unstorable = async (): Promise<unknown> => { runs += 1; return { big: 10n } }
    await assert.rejects(idempotency.execute('k', unstorable))
    assert.equal(await idempotency.get('k'), null, 'a result that cannot be stored must not persist as a failure')
    await assert.rejects(idempotency.execute('k', unstorable))
    assert.equal(runs, 2)
  })

  test('a replayed failure without a cause revives without one', async () => {
    const idempotency = instance({ persistFailures: true })
    await assert.rejects(idempotency.execute('k', async () => { throw new Error('plain') }), /plain/)
    const error = await idempotency.execute('k', async () => 'never').then(
      () => assert.fail('the persisted failure must replay'),
      (thrown: Error) => thrown
    )
    assert.equal(error.message, 'plain')
    assert.equal(error.cause, undefined)
  })

  test('a failure whose serialization itself fails replays the fallback message', async () => {
    class Nameless extends Error {
      override get name (): string { throw new Error('no name available') }
    }
    const idempotency = instance({ persistFailures: true })
    await assert.rejects(idempotency.execute('k', async () => { throw new Nameless('original') }))
    const error = await idempotency.execute('k', async () => 'never').then(
      () => assert.fail('the persisted failure must replay'),
      (thrown: Error) => thrown
    )
    assert.equal(error.message, 'failure could not be serialized')
    assert.equal(error.name, 'Error')
  })

  test('get exposes an error only on failed records, whatever the storage holds', async () => {
    const records: Record<string, StoredRecord> = {
      'failed-sans-error': {
        token: 't', status: 'failed', storedAt: 1, expiresAt: Date.now() + 60_000
      },
      'completed-with-stray-error': {
        token: 't',
        status: 'completed',
        result: '"v"',
        error: '{"name":"X","message":"stray"}',
        storedAt: 1,
        expiresAt: Date.now() + 60_000
      }
    }
    const storage: IdempotencyStorage = {
      acquire: async () => null,
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async (key) => records[key] ?? null,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage })

    const failed = await idempotency.get('failed-sans-error')
    assert.ok(failed)
    assert.ok(!('error' in failed), 'a failed record without a stored error exposes none')

    const completed = await idempotency.get('completed-with-stray-error')
    assert.ok(completed)
    assert.equal(completed.value, 'v')
    assert.ok(!('error' in completed), 'the status is the authority, not a stray field')
  })

  test('extend forwards the parsed ttl and defaults to the lock ttl', async () => {
    const memory = new MemoryStorage()
    const ttls: number[] = []
    const storage: IdempotencyStorage = {
      acquire: (record, ttl) => memory.acquire(record, ttl),
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: async (key, token, ttl) => { ttls.push(ttl); await memory.extend(key, token, ttl) },
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const idempotency = new Idempotency({ storage, lockTtl: '7s' })
    await idempotency.execute('k', async (ctx) => {
      await ctx.extend('5s')
      await ctx.extend()
      return 1
    })
    assert.deepEqual(ttls, [5_000, 7_000])
  })

  test('fail-open bypasses report replayed=false on the context and the metadata', async () => {
    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    let contextReplayed: boolean | undefined
    const open = new Idempotency({ storage: down, onStorageError: 'open' })
    const unguarded = await open.executeWithMetadata('k', async (ctx) => {
      contextReplayed = ctx.replayed
      return 'v'
    })
    assert.equal(contextReplayed, false)
    assert.equal(unguarded.replayed, false)

    const memory = new MemoryStorage()
    const brokenWrite: IdempotencyStorage = {
      acquire: (record, ttl) => memory.acquire(record, ttl),
      complete: async () => { throw new Error('write lost') },
      release: (key, token) => memory.release(key, token),
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const bypassed = await new Idempotency({ storage: brokenWrite, onStorageError: 'open' })
      .executeWithMetadata('k', async () => 'v')
    assert.equal(bypassed.replayed, false)
  })
})
