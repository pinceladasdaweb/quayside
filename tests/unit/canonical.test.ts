import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { canonicalize, fingerprintsEqual, hashCanonical } from '../../src/canonical'
import { SerializationError } from '../../src/errors'

describe('canonicalize', () => {
  test('the canonical form is the fingerprint wire format and never drifts', () => {
    assert.equal(canonicalize(null), 'null')
    assert.equal(canonicalize(undefined), 'undefined')
    assert.equal(canonicalize(true), 'bool:true')
    assert.equal(canonicalize(false), 'bool:false')
    assert.equal(canonicalize(1), 'num:1')
    assert.equal(canonicalize(-0), 'num:0')
    assert.equal(canonicalize(10n), 'bigint:10')
    assert.equal(canonicalize('a'), 'str:"a"')
    assert.equal(canonicalize(new Date(0)), 'date:1970-01-01T00:00:00.000Z')
    assert.equal(canonicalize(new Date('nope')), 'date:invalid')
    assert.equal(canonicalize(new Uint8Array([1, 255])), 'bytes:01ff')
    assert.equal(canonicalize(new Uint16Array([1, 257])), 'uint16array:[1,257]')
    assert.equal(canonicalize(new BigInt64Array([2n])), 'bigint64array:[2]')
    assert.equal(canonicalize(new DataView(new Uint8Array([1, 255]).buffer)), 'dataview:01ff')
    assert.equal(canonicalize([1, 'a']), 'arr:[num:1,str:"a"]')
    assert.equal(canonicalize({ b: 2, a: 1 }), 'obj:{"a":num:1,"b":num:2}')
    assert.equal(canonicalize({ nested: [true, null] }), 'obj:{"nested":arr:[bool:true,null]}')
  })

  test('filters apply to array indices as path segments', () => {
    assert.equal(canonicalize([1, 2], { ignoreFields: ['1'] }), 'arr:[num:1]')
    assert.equal(canonicalize([1, 2], { pickFields: ['0'] }), 'arr:[num:1]')
  })

  test('a two-segment pick requires every segment to match', () => {
    const first = { meta: { retries: 1, trace: 'a' } }
    const second = { meta: { retries: 1, trace: 'b' } }
    assert.equal(
      hashCanonical(first, { pickFields: ['meta.retries'] }),
      hashCanonical(second, { pickFields: ['meta.retries'] })
    )
    assert.notEqual(
      hashCanonical({ meta: { retries: 1 } }, { pickFields: ['meta.retries'] }),
      hashCanonical({ meta: { retries: 2 } }, { pickFields: ['meta.retries'] })
    )
  })

  test('the default configuration ignores nothing', () => {
    assert.notEqual(
      hashCanonical({ 'Stryker was here': 1 }),
      hashCanonical({ 'Stryker was here': 2 })
    )
  })

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

  test('a typed view is its interpreted values, never its raw bytes', () => {
    // The core collision this scheme exists to prevent: same bytes, another
    // meaning. Uint16Array([1]) and Uint8Array([1, 0]) share their bytes.
    assert.notEqual(hashCanonical({ v: new Uint16Array([1]) }), hashCanonical({ v: new Uint8Array([1, 0]) }))
    // Signedness is meaning too: Int8Array([-1]) and Uint8Array([255]) share a byte.
    assert.notEqual(hashCanonical(new Int8Array([-1])), hashCanonical(new Uint8Array([255])))
    assert.notEqual(hashCanonical(new Uint16Array([1])), hashCanonical(new Int16Array([1])))
    // Equal interpreted values are equal payloads, including from a subclass.
    class Halves extends Uint16Array {}
    assert.equal(hashCanonical(new Uint16Array([1, 2])), hashCanonical(new Halves([1, 2])))
    // A DataView is a tagged byte window, not a byte string.
    const bytes = new Uint8Array([1, 2])
    assert.notEqual(hashCanonical(new DataView(bytes.buffer)), hashCanonical(bytes))
    // Uint8ClampedArray reads exactly like Uint8Array: same byte content,
    // same payload.
    assert.equal(hashCanonical(new Uint8ClampedArray([1, 2])), hashCanonical(new Uint8Array([1, 2])))
    // Element values are read through the view's own window, not the whole
    // underlying buffer.
    const offset = new Uint16Array(new Uint16Array([9, 1, 257, 9]).buffer, 2, 2)
    assert.equal(hashCanonical(offset), hashCanonical(new Uint16Array([1, 257])))
    // Floating-point views carry their values deterministically.
    assert.equal(canonicalize(new Float64Array([1.5, NaN])), 'float64array:[1.5,NaN]')
  })

  test('different values of every type hash differently', () => {
    assert.notEqual(hashCanonical(true), hashCanonical(false))
    assert.notEqual(hashCanonical(1), hashCanonical(2))
    assert.notEqual(hashCanonical(10n), hashCanonical(11n))
    assert.notEqual(hashCanonical(new Date(0)), hashCanonical(new Date(1_000)))
    assert.notEqual(hashCanonical(new Uint8Array([1, 2, 3])), hashCanonical(new Uint8Array([1, 2, 4])))
    assert.notEqual(hashCanonical(null), hashCanonical(undefined))
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

  test('distinguishes nested undefined from null and invalid dates from valid ones', () => {
    assert.notEqual(hashCanonical({ a: undefined }), hashCanonical({ a: null }))
    const invalid = new Date('not a date')
    assert.equal(hashCanonical(invalid), hashCanonical(new Date('still not')))
    assert.notEqual(hashCanonical(invalid), hashCanonical(new Date(0)))
  })

  test('a pick path deeper than a sibling top-level key excludes that sibling', () => {
    const first = { a: { b: 1 }, z: 1 }
    const second = { a: { b: 1 }, z: 2 }
    assert.equal(
      hashCanonical(first, { pickFields: ['a.b'] }),
      hashCanonical(second, { pickFields: ['a.b'] })
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

describe('raw binary buffers', () => {
  test('ArrayBuffer contents drive the fingerprint, like every view of them', () => {
    const first = new Uint8Array([1, 2, 3]).buffer
    const second = new Uint8Array([9, 9, 9]).buffer
    // Without a branch of their own these hash as an empty object: two
    // different binary payloads would share a key and replay each other.
    assert.notEqual(hashCanonical({ file: first }), hashCanonical({ file: second }))
    assert.equal(hashCanonical({ file: first }), hashCanonical({ file: new Uint8Array([1, 2, 3]).buffer }))
    // A buffer and a view over the same bytes describe the same payload.
    assert.equal(canonicalize(first), canonicalize(new Uint8Array([1, 2, 3])))
    assert.equal(canonicalize(new ArrayBuffer(0)), 'bytes:')
  })

  test('SharedArrayBuffer contents drive the fingerprint too', () => {
    const shared = new SharedArrayBuffer(3)
    new Uint8Array(shared).set([1, 2, 3])
    const other = new SharedArrayBuffer(3)
    new Uint8Array(other).set([4, 5, 6])
    assert.notEqual(hashCanonical({ file: shared }), hashCanonical({ file: other }))
    assert.equal(canonicalize(shared), canonicalize(new Uint8Array([1, 2, 3])))
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
    // presence is part of the value: an absent fingerprint never equals a
    // present one, not even an empty-string one
    assert.equal(fingerprintsEqual(undefined, ''), false)
    assert.equal(fingerprintsEqual('', undefined), false)
    assert.equal(fingerprintsEqual('', ''), true)
  })
})
