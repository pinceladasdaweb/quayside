import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

describe('package entry point', () => {
  test('loads as an ES module', async () => {
    const entry = await import('../../src/index')
    assert.ok(entry)
  })
})
