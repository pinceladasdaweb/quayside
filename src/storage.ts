export const RECORD_STATUS = {
  inProgress: 'in-progress',
  completed: 'completed',
  failed: 'failed'
} as const

export type RecordStatus = (typeof RECORD_STATUS)[keyof typeof RECORD_STATUS]

export interface PendingRecord {
  key: string
  token: string
  storedAt: number
}

export type Outcome =
  | { status: 'completed', result: string }
  | { status: 'failed', error: string }

export interface StoredRecord {
  key: string
  token: string
  status: RecordStatus
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
}
