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

  test('dates are the one accepted toJSON conversion and store as ISO instants', () => {
    // The JSON convention every consumer expects: the first caller gets a
    // Date, replayed callers get the ISO string. Documented, not accidental.
    assert.equal(jsonCodec.encode(new Date(0)), '"1970-01-01T00:00:00.000Z"')
    assert.equal(jsonCodec.encode({ createdAt: new Date(0) }), '{"createdAt":"1970-01-01T00:00:00.000Z"}')
  })

  test('any other toJSON conversion is rejected, not silently stored', () => {
    // JSON.stringify runs toJSON before the replacer: without reading the
    // original off the holder, a Buffer stores as {"type":"Buffer",...} and
    // every replay serves that object instead of bytes.
    assert.throws(() => jsonCodec.encode(Buffer.from([1, 2])), (error: unknown) => {
      assert.ok(error instanceof SerializationError)
      assert.match(error.message, /Buffer/, 'the offending type is named')
      assert.match(error.message, /toJSON/, 'and the mechanism that would transform it')
      return true
    })
    assert.throws(() => jsonCodec.encode({ file: Buffer.from([1]) }), SerializationError)

    class Money { constructor (readonly cents: number) {} toJSON (): number { return this.cents } }
    assert.throws(() => jsonCodec.encode({ price: new Money(100) }), /Money values carry a toJSON conversion/)

    // Even carriers without a constructor, or functions dressed with a
    // toJSON, cannot smuggle a conversion through.
    const bare = Object.assign(Object.create(null), { toJSON: () => 1 }) as object
    assert.throws(() => jsonCodec.encode({ bare }), /toJSON-bearing values/)
    const sneaky = Object.assign(() => 1, { toJSON: () => 'called' })
    assert.throws(() => jsonCodec.encode({ sneaky }), SerializationError)
  })

  test('throws SerializationError on corrupt stored values', () => {
    assert.throws(() => jsonCodec.decode('{not json'), SerializationError)
  })
})
