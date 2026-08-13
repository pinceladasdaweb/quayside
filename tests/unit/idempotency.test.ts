import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ConcurrentExecutionError,
  Idempotency,
  SerializationError,
  StorageUnavailableError,
  WaitTimeoutError
} from '../../src/index'
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
    const winner2 = broken.execute('k2', async () => { await secondGate.opened; return 'w2' })
    await new Promise((resolve) => setImmediate(resolve))
    const waiter2 = broken.execute('k2', async () => 'l2')
    setTimeout(secondGate.open, 40)
    assert.equal(await winner2, 'w2')
    assert.equal(await waiter2, 'w2')
  })

  test('a waiter takes over after the holder fails', async () => {
    const idempotency = instance({ onConflict: 'wait' })
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
      return true
    })
  })

  test('a failed record without a stored error still replays an Error', async () => {
    const failedRecord = {
      key: 'k',
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
      return true
    })

    // The same shape observed by a waiter instead of at acquisition time.
    const inProgress = { ...failedRecord, status: 'in-progress' as const }
    const waiterStub: IdempotencyStorage = { ...stub, acquire: async () => inProgress }
    const waiting = new Idempotency({ storage: waiterStub, onConflict: 'wait' })
    await assert.rejects(waiting.execute('k', async () => 'never'), (error: unknown) => {
      assert.ok(error instanceof Error)
      return true
    })
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
    assert.equal(record.value, undefined)
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

  test('routes events to the MetricsCollector and swallows listener failures', async () => {
    const seen: string[] = []
    const idempotency = instance({
      onEvent: () => { throw new Error('listener bug') },
      metrics: {
        onAcquired: (event) => seen.push(`acquired:${event.key}`),
        onCompleted: (event) => seen.push(`completed:${event.key}`),
        onReplayed: (event) => seen.push(`replayed:${event.key}`)
      }
    })
    assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
    assert.equal(await idempotency.execute('k', async () => 'v'), 'v')
    assert.deepEqual(seen, ['acquired:k', 'completed:k', 'replayed:k'])
  })

  test('events carry the namespace when configured', async () => {
    const events: IdempotencyEvent[] = []
    const idempotency = instance({ namespace: 'payments', onEvent: (event) => events.push(event) })
    await idempotency.execute('k', async () => 1)
    assert.ok(events.every((event) => event.namespace === 'payments'))
  })
})
