import { StorageCorruptError } from './errors'

export const RECORD_STATUS = {
  inProgress: 'in-progress',
  completed: 'completed',
  failed: 'failed'
} as const

export type RecordStatus = (typeof RECORD_STATUS)[keyof typeof RECORD_STATUS]

/** The status strings a stored record may carry; anything else is corruption. */
export const VALID_STATUS: ReadonlySet<string> = new Set(Object.values(RECORD_STATUS))

/**
 * How many times an acquire may contend before giving up: a record can
 * expire or vanish between the steps of one attempt, so adapters loop
 * instead of failing on the first race, bounded so a pathological storage
 * cannot spin forever.
 */
export const MAX_ACQUIRE_ATTEMPTS = 5

/**
 * A stored record as its storage hands it back, before validation: SQL
 * rows and the Redis wire shape name these fields differently and type
 * them differently (a BIGINT may arrive as a string, the Redis wire keeps
 * epochs as strings on purpose), so adapters map their names onto this
 * shape and share the decoding below.
 */
export interface RawRecordFields {
  token: unknown
  status: unknown
  fingerprint: unknown
  result: unknown
  error: unknown
  storedAt: unknown
  expiresAt: unknown
}

/**
 * Validates and normalizes what a storage returned. Every adapter decodes
 * through here so a record that the contract cannot describe is caught the
 * same way everywhere: a status outside the state machine, a token that is
 * not a string, or a timestamp that is not a number are corruption, not
 * values to carry into fencing and expiry decisions.
 */
export function buildStoredRecord (key: string, fields: RawRecordFields): StoredRecord {
  const storedAt = Number(fields.storedAt)
  const expiresAt = Number(fields.expiresAt)
  if (
    typeof fields.token !== 'string' ||
    // A non-string status cannot be a member either, so the set lookup is
    // the whole status check.
    !VALID_STATUS.has(fields.status as string) ||
    !Number.isFinite(storedAt) ||
    !Number.isFinite(expiresAt)
  ) {
    throw new StorageCorruptError(key, `corrupt idempotency record under key "${key}"`)
  }
  const record: StoredRecord = {
    token: fields.token,
    status: fields.status as RecordStatus,
    storedAt,
    expiresAt
  }
  if (typeof fields.fingerprint === 'string') record.fingerprint = fields.fingerprint
  if (typeof fields.result === 'string') record.result = fields.result
  if (typeof fields.error === 'string') record.error = fields.error
  return record
}

export interface PendingRecord {
  key: string
  token: string
  fingerprint?: string
  storedAt: number
}

export type Outcome =
  | { status: 'completed', result: string }
  | { status: 'failed', error: string }

export interface StoredRecord {
  token: string
  status: RecordStatus
  fingerprint?: string
  result?: string
  error?: string
  storedAt: number
  expiresAt: number
}

export interface IdempotencyStorage {
  /** Atomic create-if-absent. Returns the winning record (theirs) or null (ours). */
  acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null>
  /** Fenced transition to COMPLETED/FAILED. Throws FencingError on token mismatch. */
  complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void>
  /** Fenced delete (failure path). Throws FencingError on token mismatch. */
  release (key: string, token: string): Promise<void>
  /** Fenced lock-TTL extension. Throws FencingError on token mismatch. */
  extend (key: string, token: string, lockTtlMs: number): Promise<void>
  get (key: string): Promise<StoredRecord | null>
  /** Unfenced delete (invalidate). */
  delete (key: string): Promise<void>
  /**
   * Optional low-latency wait: resolves when the record under `key` may
   * have changed, or after `timeoutMs`, whichever comes first. Purely an
   * optimization for the 'wait' conflict policy; correctness never depends
   * on it, because the caller always re-reads the record after waking.
   */
  waitForChange? (key: string, timeoutMs: number): Promise<void>
}
