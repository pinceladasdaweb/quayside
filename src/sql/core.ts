// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold across entry points, so the
// build maps '../index' onto the shipped core bundle instead of inlining a
// private copy.
import { FencingError, IdempotencyKeyInvalidError, RECORD_STATUS, StorageCorruptError } from '../index'
import type { IdempotencyStorage, Outcome, PendingRecord, RecordStatus, StoredRecord } from '../index'
// Plain shared constants carry no identity requirement, so unlike the
// errors above they may come straight from the module that defines them.
import { MAX_ACQUIRE_ATTEMPTS, VALID_STATUS } from '../storage'

/**
 * The dialect-specific SQL. Both adapters share one algorithm; only the
 * statement text (placeholders, insert-ignore syntax) differs.
 */
export interface SqlStatements {
  /** Insert-if-absent. Params: key, token, fingerprint, storedAt, expiresAt. */
  insert: string
  /** Reclaim an expired row in place. Params: token, fingerprint, storedAt, expiresAt, key, now. */
  takeover: string
  /** Select a live row. Params: key, now. */
  select: string
  /** Fenced transition to completed. Params: result, expiresAt, key, token, now. */
  completeResult: string
  /** Fenced transition to failed. Params: error, expiresAt, key, token, now. */
  completeError: string
  /** Fenced delete. Params: key, token, now. */
  release: string
  /** Fenced lock extension. Params: expiresAt, key, token, now. */
  extend: string
  /** Unfenced delete. Params: key. */
  remove: string
  /** Bulk removal of expired rows. Params: now. */
  sweep: string
}

export interface SqlRunResult {
  affected: number
  rows: Array<Record<string, unknown>>
}

export type SqlRunner = (sql: string, params: unknown[]) => Promise<SqlRunResult>

/**
 * What actually separates the two supported dialects: the parameter marker
 * and the insert-if-absent syntax. Everything else is one algorithm and one
 * set of statements, written once in buildStatements.
 */
export interface SqlDialect {
  /** Positional parameter marker for the 1-based index: '?' or '$1'. */
  placeholder (index: number): string
  /** Renders the insert-if-absent form around the shared columns/values body. */
  insertIfAbsent (tableAndValues: string): string
}

export function buildStatements (table: string, dialect: SqlDialect): SqlStatements {
  const p = (index: number): string => dialect.placeholder(index)
  const inProgress = `'${RECORD_STATUS.inProgress}'`
  return {
    insert: dialect.insertIfAbsent(`${table} (record_key, token, status, fingerprint, stored_at, expires_at) VALUES (${p(1)}, ${p(2)}, ${inProgress}, ${p(3)}, ${p(4)}, ${p(5)})`),
    takeover: `UPDATE ${table} SET token = ${p(1)}, status = ${inProgress}, fingerprint = ${p(2)}, result = NULL, error = NULL, stored_at = ${p(3)}, expires_at = ${p(4)} WHERE record_key = ${p(5)} AND expires_at <= ${p(6)}`,
    select: `SELECT record_key, token, status, fingerprint, result, error, stored_at, expires_at FROM ${table} WHERE record_key = ${p(1)} AND expires_at > ${p(2)}`,
    completeResult: `UPDATE ${table} SET status = '${RECORD_STATUS.completed}', result = ${p(1)}, expires_at = ${p(2)} WHERE record_key = ${p(3)} AND token = ${p(4)} AND status = ${inProgress} AND expires_at > ${p(5)}`,
    completeError: `UPDATE ${table} SET status = '${RECORD_STATUS.failed}', error = ${p(1)}, expires_at = ${p(2)} WHERE record_key = ${p(3)} AND token = ${p(4)} AND status = ${inProgress} AND expires_at > ${p(5)}`,
    release: `DELETE FROM ${table} WHERE record_key = ${p(1)} AND token = ${p(2)} AND status = ${inProgress} AND expires_at > ${p(3)}`,
    extend: `UPDATE ${table} SET expires_at = ${p(1)} WHERE record_key = ${p(2)} AND token = ${p(3)} AND status = ${inProgress} AND expires_at > ${p(4)}`,
    remove: `DELETE FROM ${table} WHERE record_key = ${p(1)}`,
    sweep: `DELETE FROM ${table} WHERE expires_at <= ${p(1)}`
  }
}

export function assertSafeTableName (tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new TypeError(`invalid table name "${tableName}"; only letters, digits and underscores are allowed`)
  }
}

function mapRow (key: string, row: Record<string, unknown>): StoredRecord {
  const status = String(row.status)
  if (!VALID_STATUS.has(status)) {
    throw new StorageCorruptError(key, `corrupt idempotency record under key "${key}"`)
  }
  const record: StoredRecord = {
    token: String(row.token),
    status: status as RecordStatus,
    storedAt: Number(row.stored_at),
    expiresAt: Number(row.expires_at)
  }
  if (typeof row.fingerprint === 'string') record.fingerprint = row.fingerprint
  if (typeof row.result === 'string') record.result = row.result
  if (typeof row.error === 'string') record.error = row.error
  return record
}

/**
 * Shared SQL storage algorithm: insert-if-absent is the lock, expired rows
 * are reclaimed in place (lazy cleanup, no cron required) and every
 * transition is a single token-conditional statement, so atomicity lives in
 * the database, never in read-modify-write JavaScript.
 */
export class SqlStorageCore implements IdempotencyStorage {
  private readonly run: SqlRunner
  private readonly statements: SqlStatements
  private readonly maxKeyBytes: number

  constructor (run: SqlRunner, statements: SqlStatements, maxKeyBytes: number) {
    this.run = run
    this.statements = statements
    this.maxKeyBytes = maxKeyBytes
  }

  async acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null> {
    this.assertKeyFits(record.key)
    const fingerprint = record.fingerprint ?? null
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const now = Date.now()
      const inserted = await this.run(this.statements.insert, [record.key, record.token, fingerprint, record.storedAt, now + lockTtlMs])
      if (inserted.affected === 1) return null
      const reclaimed = await this.run(this.statements.takeover, [record.token, fingerprint, record.storedAt, now + lockTtlMs, record.key, now])
      if (reclaimed.affected === 1) return null
      const selected = await this.run(this.statements.select, [record.key, now])
      const row = selected.rows[0]
      if (row !== undefined) return mapRow(record.key, row)
      // The row expired or vanished between statements: contend again.
    }
    throw new StorageCorruptError(record.key, `could not acquire or observe key "${record.key}" after ${MAX_ACQUIRE_ATTEMPTS} attempts`)
  }

  async complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const statement = outcome.status === 'completed' ? this.statements.completeResult : this.statements.completeError
    const payload = outcome.status === 'completed' ? outcome.result : outcome.error
    const applied = await this.run(statement, [payload, Date.now() + resultTtlMs, key, token, Date.now()])
    if (applied.affected !== 1) throw new FencingError(key)
  }

  async release (key: string, token: string): Promise<void> {
    const applied = await this.run(this.statements.release, [key, token, Date.now()])
    if (applied.affected !== 1) throw new FencingError(key)
  }

  async extend (key: string, token: string, lockTtlMs: number): Promise<void> {
    const applied = await this.run(this.statements.extend, [Date.now() + lockTtlMs, key, token, Date.now()])
    if (applied.affected === 1) return
    // MySQL reports zero affected rows for a no-change update (two extends
    // inside the same millisecond); a held lock makes the extend a no-op
    // success, anything else is a lost lock.
    const selected = await this.run(this.statements.select, [key, Date.now()])
    const row = selected.rows[0]
    if (row === undefined || String(row.token) !== token || String(row.status) !== RECORD_STATUS.inProgress) {
      throw new FencingError(key)
    }
  }

  async get (key: string): Promise<StoredRecord | null> {
    const selected = await this.run(this.statements.select, [key, Date.now()])
    const row = selected.rows[0]
    return row === undefined ? null : mapRow(key, row)
  }

  async delete (key: string): Promise<void> {
    await this.run(this.statements.remove, [key])
  }

  /** Bulk-removes expired rows; never required for correctness. */
  async sweep (): Promise<number> {
    const swept = await this.run(this.statements.sweep, [Date.now()])
    return swept.affected
  }

  // The key column is a bounded VARCHAR: anything the column cannot hold
  // faithfully is rejected here, never truncated (truncation would alias
  // two keys into one record, and MySQL in non-strict mode truncates
  // silently).
  private assertKeyFits (key: string): void {
    if (Buffer.byteLength(key) > this.maxKeyBytes) {
      throw new IdempotencyKeyInvalidError(key, `idempotency key is ${Buffer.byteLength(key)} bytes long and exceeds the ${this.maxKeyBytes}-byte key column; keys are rejected, never truncated`)
    }
  }
}
