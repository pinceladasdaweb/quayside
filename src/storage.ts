import { ConcurrentExecutionError, IdempotencyKeyInvalidError, StorageCorruptError } from './errors'

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

/**
 * The bounded acquire-contention loop every adapter shares. One `attempt`
 * is the adapter's atomic acquire plus its conflict read; it resolves to
 * `null` (acquired), a record (somebody live holds the key) or `undefined`
 * (the holder vanished between the two steps: contend again). Every lost
 * turn means the key WAS held by someone who released or expired a moment
 * later, so exhausting the attempts is contention, not corruption or an
 * outage: it surfaces as ConcurrentExecutionError, which the HTTP adapters
 * answer with a retryable 409, and which fail-open never runs unguarded
 * over (it is a QuaysideError, not a storage failure).
 */
export async function contendAcquire (
  key: string,
  attempt: () => Promise<StoredRecord | null | undefined>
): Promise<StoredRecord | null> {
  for (let turn = 0; turn < MAX_ACQUIRE_ATTEMPTS; turn += 1) {
    const outcome = await attempt()
    if (outcome !== undefined) return outcome
  }
  throw new ConcurrentExecutionError(key)
}

/**
 * The byte-cap key guard every bounded storage shares. `limitName` names
 * the limit that was broken (a key column, a partition key) so the failure
 * reads in the storage's own terms; the classification is everyone's: the
 * offending value is data, so the HTTP adapters answer 400, and the key is
 * rejected rather than truncated (truncation is a silent collision).
 */
export function assertKeyBytes (key: string, maxBytes: number, limitName: string): void {
  const size = Buffer.byteLength(key)
  if (size > maxBytes) {
    throw new IdempotencyKeyInvalidError(key, `idempotency key is ${size} bytes long and exceeds the ${maxBytes}-byte ${limitName}; keys are rejected, never truncated`)
  }
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
  /**
   * Atomic create-if-absent. Returns the winning record (theirs) or null
   * (ours). Two clauses of this contract are load-bearing and easy to miss:
   * an EXPIRED record must be reclaimed in place by this call (create and
   * takeover are one atomic operation, so a holder that crashed can never
   * block its key past the lock TTL), and the takeover is invisible to the
   * caller - it returns null exactly like a fresh create. An adapter that
   * only creates-if-absent permanently wedges every key whose holder died.
   */
  acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null>
  /** Fenced transition to COMPLETED/FAILED. Throws FencingError on token mismatch. */
  complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void>
  /** Fenced delete (failure path). Throws FencingError on token mismatch. */
  release (key: string, token: string): Promise<void>
  /** Fenced lock-TTL extension. Throws FencingError on token mismatch. */
  extend (key: string, token: string, lockTtlMs: number): Promise<void>
  /**
   * Reads the live record under `key`. An expired record reads as null,
   * whatever physical reclaim has got around to: expiry is a property of
   * the read, never of the store's own garbage collection.
   */
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
