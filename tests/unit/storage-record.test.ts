import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { StorageCorruptError } from '../../src/index'
import { buildStoredRecord } from '../../src/storage'
import type { RawRecordFields } from '../../src/storage'

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
