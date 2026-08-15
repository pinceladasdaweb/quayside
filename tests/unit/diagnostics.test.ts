// Error messages are not contract (codes are), but diagnostics must carry
// their context: the offending key, type or limit. These tests assert that
// presence without freezing prose.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { hashCanonical } from '../../src/canonical'
import { jsonCodec } from '../../src/codec'
import { parseDuration } from '../../src/duration'
import {
  ConcurrentExecutionError,
  FencingError,
  Idempotency,
  IdempotencyKeyInvalidError,
  IdempotencyKeyReuseError,
  SerializationError,
  StorageUnavailableError,
  WaitTimeoutError
} from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

function messageOf (fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the call to throw')
}

async function rejectionOf (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

describe('error diagnostics carry their context', () => {
  test('error classes name the key and the timeout', () => {
    assert.match(new ConcurrentExecutionError('invoice:7').message, /invoice:7/)
    assert.match(new IdempotencyKeyReuseError('invoice:7').message, /invoice:7/)
    assert.match(new WaitTimeoutError('invoice:7', 1500).message, /invoice:7/)
    assert.match(new WaitTimeoutError('invoice:7', 1500).message, /1500/)
    assert.match(new FencingError('invoice:7').message, /invoice:7/)
  })

  test('codec errors name the offending type and keep the cause', () => {
    assert.match(messageOf(() => jsonCodec.encode(() => 1)), /function/)
    assert.match(messageOf(() => jsonCodec.encode(Symbol('s'))), /symbol/)
    assert.match(messageOf(() => jsonCodec.encode(10n)), /bigint/)
    assert.match(messageOf(() => jsonCodec.encode(Number.NaN)), /NaN/)
    assert.match(messageOf(() => jsonCodec.encode({ a: undefined })), /undefined/)

    const circular: { self?: unknown } = {}
    circular.self = circular
    try {
      jsonCodec.encode(circular)
      assert.fail('expected a throw')
    } catch (error) {
      assert.ok(error instanceof SerializationError)
      assert.notEqual(error.message, '')
      assert.ok(error.cause !== undefined, 'the JSON error travels as cause')
    }
    try {
      jsonCodec.decode('{bad json')
      assert.fail('expected a throw')
    } catch (error) {
      assert.ok(error instanceof SerializationError)
      assert.notEqual(error.message, '')
      assert.ok(error.cause !== undefined)
    }
  })

  test('the undefined tombstone is a stable wire format', () => {
    assert.equal(jsonCodec.encode(undefined), 'undefined')
  })

  test('duration errors quote the rejected input', () => {
    assert.match(messageOf(() => parseDuration('soon')), /soon/)
    assert.match(messageOf(() => parseDuration('0s')), /0s/)
    assert.match(messageOf(() => parseDuration(-5)), /-5/)
  })

  test('the duration grammar anchors both ends and accepts multi-digit fractions', () => {
    assert.equal(parseDuration('1.25s'), 1_250)
    assert.throws(() => parseDuration('30sx'), TypeError)
    assert.throws(() => parseDuration('x30s'), TypeError)
  })

  test('canonicalization errors name what cannot be fingerprinted', () => {
    assert.match(messageOf(() => hashCanonical(() => 1)), /function/)
    assert.match(messageOf(() => hashCanonical(new Map())), /Map/)
    assert.match(messageOf(() => hashCanonical(new Set())), /Set/)
    assert.match(messageOf(() => hashCanonical(/x/)), /RegExp/)
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.match(messageOf(() => hashCanonical(circular)), /circular/)
  })

  test('input validation errors explain the rule that was broken', async () => {
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    assert.match(
      (await rejectionOf(idempotency.execute({ payload: { a: 1 }, ignoreFields: ['a'], pickFields: ['a'] }, async () => 1))).message,
      /mutually exclusive/
    )
    assert.match(
      (await rejectionOf(idempotency.execute({ key: 'k', ignoreFields: ['a'] }, async () => 1))).message,
      /payload/
    )
    assert.match(
      (await rejectionOf(idempotency.execute({ key: 'k', pickFields: ['a'] }, async () => 1))).message,
      /payload/
    )
    assert.match(
      (await rejectionOf(idempotency.execute({}, async () => 1))).message,
      /key or a payload/
    )
    assert.match(
      (await rejectionOf(idempotency.execute('', async () => 1))).message,
      /non-empty/
    )

    const long = new Idempotency({ storage: new MemoryStorage(), maxKeyLength: 16 })
    const overflow = await rejectionOf(long.execute('x'.repeat(17), async () => 1))
    assert.match(overflow.message, /16/)
    assert.match(overflow.message, /17/)
    // The offending value is data, not a mistake in the calling code: it
    // carries a code so adapters can answer 4xx instead of blaming the server.
    assert.ok(overflow instanceof IdempotencyKeyInvalidError)
    assert.equal(overflow.code, 'IDEMPOTENCY_KEY_INVALID')
    assert.equal(overflow.key, 'x'.repeat(17))
    assert.equal(overflow.name, 'IdempotencyKeyInvalidError')
    // Percent-encoding counts: a short but escaped key can still overflow.
    const escaped = await rejectionOf(long.execute('ü'.repeat(6), async () => 1))
    assert.ok(escaped instanceof IdempotencyKeyInvalidError)
    // Misuse of the API stays a TypeError; only policy limits get a code.
    assert.ok((await rejectionOf(long.execute('', async () => 1))) instanceof TypeError)
    // the limit is inclusive: a key of exactly maxKeyLength is accepted
    assert.equal(await long.execute('x'.repeat(16), async () => 1), 1)
  })

  test('storage failures travel as the cause of StorageUnavailableError', async () => {
    const idempotency = new Idempotency({
      storage: {
        acquire: async () => { throw new Error('ECONNREFUSED somewhere') },
        complete: async () => {},
        release: async () => {},
        extend: async () => {},
        get: async () => null,
        delete: async () => {}
      }
    })
    const error = await rejectionOf(idempotency.execute('k', async () => 1))
    assert.ok(error instanceof StorageUnavailableError)
    assert.notEqual(error.message, '')
    assert.match((error.cause as Error).message, /ECONNREFUSED/)
  })
})
