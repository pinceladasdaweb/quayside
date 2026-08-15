// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold across entry points, so the
// build maps '../index' onto the shipped core bundle instead of inlining a
// private copy.
import { FencingError, RECORD_STATUS } from '../index'
import type { IdempotencyStorage, Outcome, PendingRecord, StoredRecord } from '../index'

/**
 * Reference implementation of the storage contract. Single-threaded Map
 * semantics make every transition atomic by construction; expiry is
 * reclaimed lazily so expired records read as absent, exactly like the
 * lazy-reclaim SQL adapters.
 *
 * Intended for tests and development, not for multi-process deployments.
 */
export interface MemoryStorageOptions {
  /** Time source; tests inject a manual clock to pin expiry boundaries. */
  now? (): number
}

export class MemoryStorage implements IdempotencyStorage {
  private readonly records = new Map<string, StoredRecord>()
  private readonly now: () => number

  constructor (options: MemoryStorageOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  async acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null> {
    const existing = this.lookup(record.key)
    if (existing !== undefined) return { ...existing }
    this.records.set(record.key, {
      token: record.token,
      status: RECORD_STATUS.inProgress,
      fingerprint: record.fingerprint,
      storedAt: record.storedAt,
      expiresAt: this.now() + lockTtlMs
    })
    return null
  }

  async complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const existing = this.lookup(key)
    if (existing === undefined || existing.token !== token || existing.status !== RECORD_STATUS.inProgress) {
      throw new FencingError(key)
    }
    const next: StoredRecord = {
      ...existing,
      status: outcome.status,
      expiresAt: this.now() + resultTtlMs
    }
    if (outcome.status === 'completed') next.result = outcome.result
    else next.error = outcome.error
    this.records.set(key, next)
  }

  async release (key: string, token: string): Promise<void> {
    const existing = this.lookup(key)
    if (existing === undefined || existing.token !== token || existing.status !== RECORD_STATUS.inProgress) {
      throw new FencingError(key)
    }
    this.records.delete(key)
  }

  async extend (key: string, token: string, lockTtlMs: number): Promise<void> {
    const existing = this.lookup(key)
    if (existing === undefined || existing.token !== token || existing.status !== RECORD_STATUS.inProgress) {
      throw new FencingError(key)
    }
    this.records.set(key, { ...existing, expiresAt: this.now() + lockTtlMs })
  }

  async get (key: string): Promise<StoredRecord | null> {
    const existing = this.lookup(key)
    return existing === undefined ? null : { ...existing }
  }

  async delete (key: string): Promise<void> {
    this.records.delete(key)
  }

  private lookup (key: string): StoredRecord | undefined {
    const record = this.records.get(key)
    if (record === undefined) return undefined
    if (record.expiresAt <= this.now()) {
      this.records.delete(key)
      return undefined
    }
    return record
  }
}
