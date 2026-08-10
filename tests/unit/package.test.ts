import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

describe('package entry points', () => {
  test('core entry exposes the Idempotency class', async () => {
    const entry = await import('../../src/index')
    assert.equal(typeof entry.Idempotency, 'function')
  })

  test('memory entry exposes the MemoryStorage adapter', async () => {
    const entry = await import('../../src/memory/index')
    assert.equal(typeof entry.MemoryStorage, 'function')
  })
})
