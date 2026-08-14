import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { FencingError, RECORD_STATUS } from '../../src/index'
import type { IdempotencyStorage, PendingRecord } from '../../src/index'

type StorageFactory = () => IdempotencyStorage | Promise<IdempotencyStorage>

function pending (key: string, token = 'token-1'): PendingRecord {
  return { key, token, storedAt: Date.now() }
}

/**
 * Contract suite every storage adapter must pass. Covers the fencing
 * discipline plus the two invariants no adapter may violate: expired
 * records read as absent even before physical reclaim, and keys are stored
 * faithfully or rejected, never truncated.
 */
export function runStorageContract (name: string, createStorage: StorageFactory): void {
  describe(`storage contract: ${name}`, () => {
    test('acquire on a fresh key returns null and stores an in-progress record', async () => {
      const storage = await createStorage()
      const winner = await storage.acquire(pending('k1'), 1_000)
      assert.equal(winner, null)
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.key, 'k1')
      assert.equal(record.token, 'token-1')
      assert.equal(record.status, RECORD_STATUS.inProgress)
    })

    test('acquire while another holder is in progress returns the holder record', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1', 'holder'), 1_000)
      const theirs = await storage.acquire(pending('k1', 'challenger'), 1_000)
      assert.ok(theirs)
      assert.equal(theirs.token, 'holder')
      assert.equal(theirs.status, RECORD_STATUS.inProgress)
    })

    test('complete transitions to completed and stores the result', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.complete('k1', 'token-1', { status: 'completed', result: '"ok"' }, 1_000)
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.status, RECORD_STATUS.completed)
      assert.equal(record.result, '"ok"')
    })

    test('complete transitions to failed and stores the error', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.complete('k1', 'token-1', { status: 'failed', error: '"boom"' }, 1_000)
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.status, RECORD_STATUS.failed)
      assert.equal(record.error, '"boom"')
    })

    test('complete with a stale token fails with FencingError and never overwrites', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1', 'holder'), 1_000)
      await assert.rejects(
        storage.complete('k1', 'stale', { status: 'completed', result: '"hijacked"' }, 1_000),
        FencingError
      )
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.status, RECORD_STATUS.inProgress)
      assert.equal(record.result, undefined)
    })

    test('complete after the record reached a terminal state fails with FencingError', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.complete('k1', 'token-1', { status: 'completed', result: '"first"' }, 1_000)
      await assert.rejects(
        storage.complete('k1', 'token-1', { status: 'completed', result: '"second"' }, 1_000),
        FencingError
      )
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.result, '"first"')
    })

    test('release deletes the record with the holder token', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.release('k1', 'token-1')
      assert.equal(await storage.get('k1'), null)
    })

    test('release with a stale token fails with FencingError and keeps the record', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1', 'holder'), 1_000)
      await assert.rejects(storage.release('k1', 'stale'), FencingError)
      assert.ok(await storage.get('k1'))
    })

    test('extend prolongs the lock with the holder token', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 40)
      await storage.extend('k1', 'token-1', 5_000)
      await sleep(60)
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.status, RECORD_STATUS.inProgress)
    })

    test('extend with a stale token fails with FencingError', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1', 'holder'), 1_000)
      await assert.rejects(storage.extend('k1', 'stale', 5_000), FencingError)
    })

    test('release and extend after a terminal state fail and keep the stored outcome', async () => {
      // A late cleanup from the holder itself must never delete or prolong
      // a result that already committed.
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.complete('k1', 'token-1', { status: 'completed', result: '"kept"' }, 60_000)
      await assert.rejects(storage.release('k1', 'token-1'), FencingError)
      await assert.rejects(storage.extend('k1', 'token-1', 5_000), FencingError)
      const record = await storage.get('k1')
      assert.equal(record?.status, RECORD_STATUS.completed)
      assert.equal(record?.result, '"kept"')
    })

    test('an expired lock reads as absent and the key can be re-acquired', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1', 'crashed'), 30)
      await sleep(50)
      assert.equal(await storage.get('k1'), null)
      const winner = await storage.acquire(pending('k1', 'recovered'), 1_000)
      assert.equal(winner, null)
      const record = await storage.get('k1')
      assert.ok(record)
      assert.equal(record.token, 'recovered')
    })

    test('an expired result reads as absent and the key can be re-acquired', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.complete('k1', 'token-1', { status: 'completed', result: '"ok"' }, 30)
      await sleep(50)
      assert.equal(await storage.get('k1'), null)
      assert.equal(await storage.acquire(pending('k1', 'fresh'), 1_000), null)
    })

    test('a fenced operation on an expired record fails with FencingError', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 30)
      await sleep(50)
      await assert.rejects(
        storage.complete('k1', 'token-1', { status: 'completed', result: '"late"' }, 1_000),
        FencingError
      )
    })

    test('acquire stores the fingerprint and it survives completion', async () => {
      const storage = await createStorage()
      const fingerprint = 'f'.repeat(64)
      await storage.acquire({ ...pending('k1'), fingerprint }, 1_000)
      const held = await storage.get('k1')
      assert.ok(held)
      assert.equal(held.fingerprint, fingerprint)
      await storage.complete('k1', 'token-1', { status: 'completed', result: '"ok"' }, 1_000)
      const completed = await storage.get('k1')
      assert.ok(completed)
      assert.equal(completed.fingerprint, fingerprint)
    })

    test('fenced operations on a missing key fail with FencingError', async () => {
      const storage = await createStorage()
      await assert.rejects(
        storage.complete('ghost', 'token-1', { status: 'completed', result: '"x"' }, 1_000),
        FencingError
      )
      await assert.rejects(storage.release('ghost', 'token-1'), FencingError)
      await assert.rejects(storage.extend('ghost', 'token-1', 1_000), FencingError)
    })

    test('delete removes the record unconditionally', async () => {
      const storage = await createStorage()
      await storage.acquire(pending('k1'), 1_000)
      await storage.delete('k1')
      assert.equal(await storage.get('k1'), null)
    })

    test('keys are stored faithfully or rejected, never truncated', async () => {
      const storage = await createStorage()
      const longKey = `ns:${'x'.repeat(600)}:suffix`
      let stored: boolean
      try {
        await storage.acquire(pending(longKey), 1_000)
        stored = true
      } catch {
        stored = false
      }
      if (stored) {
        const record = await storage.get(longKey)
        assert.ok(record)
        assert.equal(record.key, longKey)
        assert.equal(await storage.get(longKey.slice(0, 512)), null)
      }
    })
  })
}
