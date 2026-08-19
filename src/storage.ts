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
