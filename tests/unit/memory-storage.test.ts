import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStorage } from '../../src/memory/index'
import { runStorageContract } from '../contract/storage-contract'

runStorageContract('MemoryStorage', () => new MemoryStorage())

describe('lazy expiry reclaim', () => {
  test('an expired record is physically removed on lookup, not merely hidden', async () => {
    let now = 0
    const storage = new MemoryStorage({ now: () => now })
    await storage.acquire({ key: 'k', token: 't', storedAt: 0 }, 1_000)
    now = 1_000
    assert.equal(await storage.get('k'), null)
    // The map itself must shrink: hiding expired entries without deleting
    // them would grow unbounded under churning keys.
    const records = (storage as unknown as { records: Map<string, unknown> }).records
    assert.equal(records.size, 0)
  })
})
