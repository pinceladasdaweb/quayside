import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { parseDuration } from '../../src/duration'

describe('parseDuration', () => {
  test('passes plain millisecond numbers through', () => {
    assert.equal(parseDuration(1500), 1500)
    assert.equal(parseDuration(0.6), 1)
  })

  test('parses unit strings', () => {
    assert.equal(parseDuration('500ms'), 500)
    assert.equal(parseDuration('30s'), 30_000)
    assert.equal(parseDuration('10m'), 600_000)
    assert.equal(parseDuration('24h'), 86_400_000)
    assert.equal(parseDuration('7d'), 604_800_000)
    assert.equal(parseDuration('1.5s'), 1_500)
  })

  test('rejects non-positive numbers', () => {
    assert.throws(() => parseDuration(0), RangeError)
    assert.throws(() => parseDuration(-5), RangeError)
    assert.throws(() => parseDuration(Number.NaN), RangeError)
    assert.throws(() => parseDuration(Number.POSITIVE_INFINITY), RangeError)
  })

  test('rejects malformed strings', () => {
    assert.throws(() => parseDuration('soon'), TypeError)
    assert.throws(() => parseDuration('10'), TypeError)
    assert.throws(() => parseDuration('10 s'), TypeError)
    assert.throws(() => parseDuration('-30s'), TypeError)
    assert.throws(() => parseDuration(''), TypeError)
  })

  test('rejects zero-valued strings', () => {
    assert.throws(() => parseDuration('0s'), RangeError)
  })

  test('rejects positive values that round down to zero', () => {
    // A zero TTL expires the record the instant it is written, so every
    // completion would fail fencing: these must not slip past the guard.
    assert.throws(() => parseDuration(0.4), RangeError)
    assert.throws(() => parseDuration(0.49), RangeError)
    assert.throws(() => parseDuration('0.4ms'), RangeError)
    // The boundary itself still rounds up to a usable duration.
    assert.equal(parseDuration(0.5), 1)
    assert.equal(parseDuration('0.5ms'), 1)
  })
})
