import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { ConcurrentExecutionError, IdempotencyKeyInvalidError, StorageCorruptError } from '../../src/index'
import { MAX_ACQUIRE_ATTEMPTS, assertKeyBytes, buildStoredRecord, contendAcquire } from '../../src/storage'
import type { RawRecordFields, StoredRecord } from '../../src/storage'

// The decoder every storage adapter shares. The adapters themselves are
// covered against real servers by the integration suite; the validation
// they delegate here is pinned at the unit level, where every corrupt
// shape is cheap to state.
function fields (over: Partial<RawRecordFields> = {}): RawRecordFields {
  return {
    token: 'tok',
    status: 'in-progress',
    fingerprint: undefined,
    result: undefined,
    error: undefined,
    storedAt: 1_000,
    expiresAt: 2_000,
    ...over
  }
}

describe('buildStoredRecord', () => {
  test('normalizes a well-formed record, whatever numeric shape the driver used', () => {
    // Postgres hands BIGINT back as a string; the Redis wire keeps epochs
    // as strings on purpose. Both must land as numbers.
    assert.deepEqual(buildStoredRecord('k', fields({ storedAt: '1000', expiresAt: '2000' })), {
      token: 'tok',
      status: 'in-progress',
      storedAt: 1_000,
      expiresAt: 2_000
    })
  })

  test('optional fields are carried only when they are strings', () => {
    const full = buildStoredRecord('k', fields({
      status: 'completed',
      fingerprint: 'fp',
      result: '"v"',
      error: 'ignored-but-present'
    }))
    assert.equal(full.fingerprint, 'fp')
    assert.equal(full.result, '"v"')
    assert.equal(full.error, 'ignored-but-present')

    // A NULL column arrives as null, not as a string: it is absence.
    const sparse = buildStoredRecord('k', fields({ fingerprint: null, result: null, error: null }))
    assert.ok(!('fingerprint' in sparse))
    assert.ok(!('result' in sparse))
    assert.ok(!('error' in sparse))
  })

  test('every state the contract cannot describe is corruption', () => {
    const corrupt: Array<[string, Partial<RawRecordFields>]> = [
      ['a status outside the state machine', { status: 'half-done' }],
      ['a non-string status', { status: 42 }],
      ['a non-string token', { token: null }],
      ['a missing token', { token: undefined }],
      ['an unparsable storedAt', { storedAt: 'not-a-number' }],
      ['an unparsable expiresAt', { expiresAt: undefined }]
    ]
    for (const [label, over] of corrupt) {
      assert.throws(
        () => buildStoredRecord('k', fields(over)),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptError, `${label} must be corruption`)
          assert.equal(error.code, 'IDEMPOTENCY_STORAGE_CORRUPT')
          assert.equal(error.key, 'k')
          assert.match(error.message, /corrupt idempotency record under key "k"/)
          return true
        },
        label
      )
    }
  })

  test('each valid status is accepted', () => {
    for (const status of ['in-progress', 'completed', 'failed']) {
      assert.equal(buildStoredRecord('k', fields({ status })).status, status)
    }
  })
})

// The contention loop every adapter delegates to. The adapters' own
// attempt shapes are covered by the integration suite; the loop's bound
// and its exhaustion classification are pinned here, where they are cheap
// to state and where mutation can see them (the adapters are excluded).
describe('contendAcquire', () => {
  const held = buildStoredRecord('k', fields())

  test('an acquired attempt resolves null without another turn', async () => {
    let turns = 0
    assert.equal(await contendAcquire('k', async () => { turns += 1; return null }), null)
    assert.equal(turns, 1)
  })

  test('a live holder resolves as the winning record without another turn', async () => {
    let turns = 0
    const winner = await contendAcquire('k', async () => { turns += 1; return held })
    assert.equal(winner, held)
    assert.equal(turns, 1)
  })

  test('an expired-between-steps attempt contends again until it lands', async () => {
    let turns = 0
    const outcomes: Array<StoredRecord | null | undefined> = [undefined, undefined, null]
    const winner = await contendAcquire('k', async () => outcomes[turns++])
    assert.equal(winner, null)
    assert.equal(turns, 3, 'the loop retried exactly as many times as the race demanded')
  })

  test('exhaustion is contention, never corruption or an outage', async () => {
    // Every lost turn means somebody held the key and let go a moment
    // later (a burst of fast-failing requests releasing within one round
    // trip). That is a key in use, so it surfaces as the retryable conflict
    // the HTTP adapters answer with 409, not as a 500 on a healthy store;
    // and being a quayside error, fail-open never runs unguarded over it.
    let turns = 0
    await assert.rejects(
      contendAcquire('k', async () => { turns += 1; return undefined }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrentExecutionError)
        assert.equal(error.code, 'IDEMPOTENCY_IN_PROGRESS')
        assert.equal(error.key, 'k')
        return true
      }
    )
    assert.equal(turns, MAX_ACQUIRE_ATTEMPTS, 'the loop is bounded, never infinite')
  })
})

// The byte-cap guard the bounded storages share.
describe('assertKeyBytes', () => {
  test('a key within the limit passes, measured in bytes rather than characters', () => {
    assert.doesNotThrow(() => assertKeyBytes('x'.repeat(16), 16, 'key column'))
    // Two-byte characters: 9 of them fit 16 bytes as characters but not as bytes.
    assert.throws(() => assertKeyBytes('é'.repeat(9), 16, 'key column'))
  })

  test('an oversized key is rejected naming the limit, never truncated', () => {
    assert.throws(
      () => assertKeyBytes('x'.repeat(17), 16, 'partition key limit'),
      (error: unknown) => {
        assert.ok(error instanceof IdempotencyKeyInvalidError)
        assert.equal(error.code, 'IDEMPOTENCY_KEY_INVALID')
        assert.equal(error.key, 'x'.repeat(17))
        assert.match(error.message, /17 bytes long and exceeds the 16-byte partition key limit/)
        assert.match(error.message, /rejected, never truncated/)
        return true
      }
    )
  })
})
