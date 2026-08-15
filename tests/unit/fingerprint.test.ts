import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { hashCanonical } from '../../src/canonical'
import { Idempotency, IdempotencyKeyInvalidError, IdempotencyKeyReuseError } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

function gate () {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

function instance (overrides: Partial<ConstructorParameters<typeof Idempotency>[0]> = {}) {
  return new Idempotency({ storage: new MemoryStorage(), ...overrides })
}

describe('payload fingerprint', () => {
  test('same key and equivalent payload replays, regardless of key order', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return 'v' }
    await idempotency.execute({ key: 'k', payload: { a: 1, b: 2 } }, fn)
    await idempotency.execute({ key: 'k', payload: { b: 2, a: 1 } }, fn)
    assert.equal(calls, 1)
  })

  test('same key with a different payload fails with IdempotencyKeyReuseError', async () => {
    const idempotency = instance()
    await idempotency.execute({ key: 'k', payload: { amount: 10 } }, async () => 'v')
    await assert.rejects(
      idempotency.execute({ key: 'k', payload: { amount: 99 } }, async () => 'v'),
      (error: unknown) => {
        assert.ok(error instanceof IdempotencyKeyReuseError)
        assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSE')
        assert.equal(error.key, 'k')
        return true
      }
    )
  })

  test('key reuse is detected while the first execution is still in progress', async () => {
    const idempotency = instance()
    const { open, opened } = gate()
    const running = idempotency.execute({ key: 'k', payload: { amount: 10 } }, async () => {
      await opened
      return 'v'
    })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(
      idempotency.execute({ key: 'k', payload: { amount: 99 } }, async () => 'v'),
      IdempotencyKeyReuseError
    )
    open()
    await running
  })

  test('a key stored without payload cannot be reused with one, and vice versa', async () => {
    const idempotency = instance()
    await idempotency.execute({ key: 'a' }, async () => 'v')
    await assert.rejects(
      idempotency.execute({ key: 'a', payload: { x: 1 } }, async () => 'v'),
      IdempotencyKeyReuseError
    )
    await idempotency.execute({ key: 'b', payload: { x: 1 } }, async () => 'v')
    await assert.rejects(
      idempotency.execute({ key: 'b' }, async () => 'v'),
      IdempotencyKeyReuseError
    )
  })
})

describe('payload-derived keys', () => {
  test('the same payload derives the same key and executes once', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return 'v' }
    await idempotency.execute({ payload: { order: 7, items: ['a'] } }, fn)
    await idempotency.execute({ payload: { items: ['a'], order: 7 } }, fn)
    assert.equal(calls, 1)
  })

  test('different payloads derive different keys', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    await idempotency.execute({ payload: { order: 7 } }, fn)
    await idempotency.execute({ payload: { order: 8 } }, fn)
    assert.equal(calls, 2)
  })

  test('ignoreFields excludes volatile fields from the derived key', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return 'v' }
    await idempotency.execute(
      { payload: { order: 7, meta: { timestamp: 1 } }, ignoreFields: ['meta.timestamp'] },
      fn
    )
    await idempotency.execute(
      { payload: { order: 7, meta: { timestamp: 2 } }, ignoreFields: ['meta.timestamp'] },
      fn
    )
    assert.equal(calls, 1)
  })

  test('a pick keeps its whole subtree, and the ancestors leading to it', async () => {
    // Both directions of the prefix test: a node under the pick belongs to
    // it, and the nodes above a deep pick have to survive for it to be
    // reachable at all.
    const under = (city: string, noise: number) =>
      hashCanonical({ customer: { address: { city } }, noise }, { pickFields: ['customer'] })
    assert.notEqual(under('SP', 1), under('RJ', 1), 'a change deep under the pick changes the key')
    assert.equal(under('SP', 1), under('SP', 999), 'noise outside the pick is still ignored')

    const deep = (city: string, zip: string) =>
      hashCanonical({ customer: { address: { city, zip } } }, { pickFields: ['customer.address.city'] })
    assert.notEqual(deep('SP', '01310'), deep('RJ', '01310'), 'the picked leaf drives the key')
    assert.equal(deep('SP', '01310'), deep('SP', '99999'), 'its siblings do not')
  })

  test('pickFields derives the key from the selected paths only', async () => {
    const idempotency = instance()
    let calls = 0
    const fn = async () => { calls += 1; return 'v' }
    await idempotency.execute({ payload: { order: 7, requestId: 'r-1' }, pickFields: ['order'] }, fn)
    await idempotency.execute({ payload: { order: 7, requestId: 'r-2' }, pickFields: ['order'] }, fn)
    assert.equal(calls, 1)
  })

  test('rejects invalid input combinations', async () => {
    const idempotency = instance()
    await assert.rejects(idempotency.execute({}, async () => 'v'), TypeError)
    await assert.rejects(
      idempotency.execute({ payload: { a: 1 }, ignoreFields: ['a'], pickFields: ['a'] }, async () => 'v'),
      TypeError
    )
    await assert.rejects(
      idempotency.execute({ key: 'k', ignoreFields: ['a'] }, async () => 'v'),
      TypeError
    )
  })
})

describe('key hygiene', () => {
  test('percent-encoded segments prevent namespace impersonation', async () => {
    const storage = new MemoryStorage()
    const a = new Idempotency({ storage, namespace: 'pay' })
    const b = new Idempotency({ storage, namespace: 'pay:x' })
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    // Without encoding both would compose the storage key 'pay:x:y'.
    await a.execute('x:y', fn)
    await b.execute('y', fn)
    assert.equal(calls, 2)
  })

  test('rejects keys longer than maxKeyLength instead of truncating', async () => {
    const idempotency = instance()
    await assert.rejects(idempotency.execute('x'.repeat(600), async () => 'v'), IdempotencyKeyInvalidError)
  })

  test('maxKeyLength is configurable', async () => {
    const idempotency = instance({ maxKeyLength: 2048 })
    assert.equal(await idempotency.execute('x'.repeat(600), async () => 'v'), 'v')
    const strict = instance({ maxKeyLength: 16 })
    await assert.rejects(strict.execute('x'.repeat(17), async () => 'v'), IdempotencyKeyInvalidError)
  })

  test('get and invalidate address the same hygienic key as execute', async () => {
    const idempotency = instance({ namespace: 'ns' })
    await idempotency.execute('with:separator', async () => 'v')
    const record = await idempotency.get('with:separator')
    assert.ok(record)
    assert.equal(record.value, 'v')
    await idempotency.invalidate('with:separator')
    assert.equal(await idempotency.get('with:separator'), null)
  })
})
