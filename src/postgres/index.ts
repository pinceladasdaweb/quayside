import type { SqlDialect, SqlRunner } from '../sql/core'
import {
  DEFAULT_MAX_KEY_BYTES,
  DEFAULT_TABLE,
  KEY_COLUMN,
  SqlStorageCore,
  assertKeyCapacity,
  assertSafeTableName,
  buildStatements
} from '../sql/core'

export type { SqlRunResult, SqlRunner, SqlStatements } from '../sql/core'

/**
 * Minimal pg-shaped surface. Structural on purpose: a pg Pool, Client or
 * PoolClient satisfies it without quayside declaring a driver dependency.
 */
export interface PostgresClientLike {
  query (text: string, values?: unknown[]): Promise<{ rowCount: number | null, rows: Array<Record<string, unknown>> }>
}

export interface PostgresStorageOptions {
  /** Table holding the records. Default: 'quayside_records'. */
  tableName?: string
  /**
   * Byte capacity of the key column; longer keys are rejected. Default:
   * 512. `migrate()` declares the column from this value, so the guard and
   * the column it protects can never disagree.
   */
  maxKeyBytes?: number
}

/**
 * The DDL executed by migrate(), for external migration tools. The key
 * column is sized from `maxKeyBytes` so a storage configured with a wider
 * limit gets a column that can hold what its guard admits.
 */
export function postgresMigration (tableName: string = DEFAULT_TABLE, maxKeyBytes: number = DEFAULT_MAX_KEY_BYTES): string {
  assertSafeTableName(tableName)
  assertKeyCapacity(maxKeyBytes)
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  ${KEY_COLUMN} VARCHAR(${maxKeyBytes}) PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT,
  result TEXT,
  error TEXT,
  stored_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${tableName}_expires_at ON ${tableName} (expires_at);`
}

const POSTGRES_DIALECT: SqlDialect = {
  placeholder: (index) => `$${index}`,
  insertIfAbsent: (tableAndValues) => `INSERT INTO ${tableAndValues} ON CONFLICT (${KEY_COLUMN}) DO NOTHING`
}

/**
 * PostgreSQL storage adapter: INSERT ... ON CONFLICT DO NOTHING is the
 * atomic acquire, expired rows are reclaimed in place (lazy cleanup, no
 * cron required) and every fenced transition is one token-conditional
 * UPDATE/DELETE, so atomicity lives in the database.
 */
export class PostgresStorage extends SqlStorageCore {
  private readonly client: PostgresClientLike
  private readonly tableName: string

  constructor (client: PostgresClientLike, options: PostgresStorageOptions = {}) {
    const tableName = options.tableName ?? DEFAULT_TABLE
    assertSafeTableName(tableName)
    const run: SqlRunner = async (sql, params) => {
      const result = await client.query(sql, params)
      return { affected: result.rowCount ?? 0, rows: result.rows }
    }
    super(run, buildStatements(tableName, POSTGRES_DIALECT), options.maxKeyBytes ?? DEFAULT_MAX_KEY_BYTES)
    this.client = client
    this.tableName = tableName
  }

  /** Creates the table and its expiry index when they do not exist. */
  async migrate (): Promise<void> {
    for (const statement of postgresMigration(this.tableName, this.maxKeyBytes).split(';')) {
      if (statement.trim() !== '') await this.client.query(statement)
    }
  }
}
