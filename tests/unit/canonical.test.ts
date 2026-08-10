import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { canonicalize, fingerprintsEqual, hashCanonical } from '../../src/canonical'
import { SerializationError } from '../../src/errors'

describe('canonicalize', () => {
  test('is independent of key insertion order at every depth', () => {
    const a = { user: { name: 'ana', roles: ['x', 'y'] }, total: 10 }
    const b = { total: 10, user: { roles: ['x', 'y'], name: 'ana' } }
    assert.equal(canonicalize(a), canonicalize(b))
  })

  test('type tags keep values JSON would conflate apart', () => {
    assert.notEqual(hashCanonical(1), hashCanonical('1'))
    assert.notEqual(hashCanonical(true), hashCanonical('true'))
    assert.notEqual(hashCanonical(null), hashCanonical('null'))
    assert.notEqual(hashCanonical([1]), hashCanonical({ 0: 1 }))
    assert.notEqual(hashCanonical({}), hashCanonical([]))
  })

  test('array order matters, object key order does not', () => {
    assert.notEqual(hashCanonical([1, 2]), hashCanonical([2, 1]))
    assert.equal(hashCanonical({ a: 1, b: 2 }), hashCanonical({ b: 2, a: 1 }))
  })

  test('normalizes negative zero and supports bigint, Date and binary views', () => {
    assert.equal(hashCanonical(-0), hashCanonical(0))
    assert.equal(hashCanonical(10n), hashCanonical(10n))
    assert.notEqual(hashCanonical(10n), hashCanonical(10))
    const when = new Date('2026-08-10T12:00:00.000Z')
    assert.equal(hashCanonical({ when }), hashCanonical({ when: new Date(when) }))
    assert.equal(
      hashCanonical(new Uint8Array([1, 2, 3])),
      hashCanonical(Buffer.from([1, 2, 3]))
    )
  })

  test('treats an own __proto__ key as plain data without polluting', () => {
    const crafted = JSON.parse('{"__proto__": {"admin": true}, "a": 1}') as object
    const plain = { a: 1 }
    assert.notEqual(hashCanonical(crafted), hashCanonical(plain))
    assert.equal(({} as { admin?: boolean }).admin, undefined)
  })

  test('ignoreFields removes a subtree from the fingerprint', () => {
    const first = { order: 7, meta: { timestamp: 1, trace: 'a' } }
    const second = { order: 7, meta: { timestamp: 2, trace: 'b' } }
    assert.notEqual(hashCanonical(first), hashCanonical(second))
    assert.equal(
      hashCanonical(first, { ignoreFields: ['meta'] }),
      hashCanonical(second, { ignoreFields: ['meta'] })
    )
    assert.notEqual(
      hashCanonical(first, { ignoreFields: ['meta.timestamp'] }),
      hashCanonical(second, { ignoreFields: ['meta.timestamp'] })
    )
  })

  test('pickFields keeps only the selected paths', () => {
    const first = { order: 7, requestId: 'r-1', meta: { retries: 0 } }
    const second = { order: 7, requestId: 'r-2', meta: { retries: 3 } }
    assert.equal(
      hashCanonical(first, { pickFields: ['order'] }),
      hashCanonical(second, { pickFields: ['order'] })
    )
    assert.notEqual(
      hashCanonical(first, { pickFields: ['order', 'requestId'] }),
      hashCanonical(second, { pickFields: ['order', 'requestId'] })
    )
  })

  test('rejects values it cannot canonicalize deterministically', () => {
    assert.throws(() => hashCanonical(() => 1), SerializationError)
    assert.throws(() => hashCanonical(Symbol('s')), SerializationError)
    assert.throws(() => hashCanonical(new Map([['a', 1]])), SerializationError)
    assert.throws(() => hashCanonical(new Set([1])), SerializationError)
    assert.throws(() => hashCanonical(/x/), SerializationError)
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.throws(() => hashCanonical(circular), SerializationError)
  })

  test('allows repeated (non-circular) references to the same object', () => {
    const shared = { id: 1 }
    assert.equal(
      hashCanonical({ a: shared, b: shared }),
      hashCanonical({ a: { id: 1 }, b: { id: 1 } })
    )
  })
})

describe('fingerprintsEqual', () => {
  test('compares fingerprints and treats undefined as its own value', () => {
    assert.equal(fingerprintsEqual('abc', 'abc'), true)
    assert.equal(fingerprintsEqual('abc', 'abd'), false)
    assert.equal(fingerprintsEqual('abc', 'abcd'), false)
    assert.equal(fingerprintsEqual(undefined, undefined), true)
    assert.equal(fingerprintsEqual('abc', undefined), false)
    assert.equal(fingerprintsEqual(undefined, 'abc'), false)
  })
})
