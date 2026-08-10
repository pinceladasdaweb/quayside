import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { jsonCodec } from '../../src/codec'
import { SerializationError } from '../../src/errors'

describe('jsonCodec', () => {
  test('round-trips JSON values', () => {
    const values: unknown[] = [
      null,
      true,
      42,
      'text',
      [1, 2, 3],
      { nested: { list: ['a', 'b'], count: 2 } }
    ]
    for (const value of values) {
      assert.deepEqual(jsonCodec.decode(jsonCodec.encode(value)), value)
    }
  })

  test('round-trips a top-level undefined through the tombstone', () => {
    const encoded = jsonCodec.encode(undefined)
    assert.equal(jsonCodec.decode(encoded), undefined)
  })

  test('the tombstone never collides with the string "undefined"', () => {
    const encoded = jsonCodec.encode('undefined')
    assert.equal(jsonCodec.decode(encoded), 'undefined')
  })

  test('throws SerializationError on functions and symbols', () => {
    assert.throws(() => jsonCodec.encode(() => 1), SerializationError)
    assert.throws(() => jsonCodec.encode(Symbol('s')), SerializationError)
    assert.throws(() => jsonCodec.encode({ callback: () => 1 }), SerializationError)
  })

  test('throws SerializationError on bigint', () => {
    assert.throws(() => jsonCodec.encode(10n), SerializationError)
    assert.throws(() => jsonCodec.encode({ total: 10n }), SerializationError)
  })

  test('throws SerializationError on non-finite numbers', () => {
    assert.throws(() => jsonCodec.encode(Number.NaN), SerializationError)
    assert.throws(() => jsonCodec.encode({ ratio: Number.POSITIVE_INFINITY }), SerializationError)
  })

  test('throws SerializationError on nested undefined', () => {
    assert.throws(() => jsonCodec.encode({ missing: undefined }), SerializationError)
    assert.throws(() => jsonCodec.encode([1, undefined, 3]), SerializationError)
  })

  test('throws SerializationError on circular references', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.throws(() => jsonCodec.encode(circular), SerializationError)
  })

  test('throws SerializationError on corrupt stored values', () => {
    assert.throws(() => jsonCodec.decode('{not json'), SerializationError)
  })
})
