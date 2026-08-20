import type { SqlDialect, SqlRunner } from '../sql/core'
import { SqlStorageCore, assertSafeTableName, buildStatements } from '../sql/core'

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
  /** Byte capacity of the key column; longer keys are rejected. Default: 512. */
  maxKeyBytes?: number
}

const DEFAULT_TABLE = 'quayside_records'

/** The DDL executed by migrate(), for external migration tools. */
export function postgresMigration (tableName: string = DEFAULT_TABLE): string {
  assertSafeTableName(tableName)
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  record_key VARCHAR(512) PRIMARY KEY,
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
  insertIfAbsent: (tableAndValues) => `INSERT INTO ${tableAndValues} ON CONFLICT (record_key) DO NOTHING`
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
    super(run, buildStatements(tableName, POSTGRES_DIALECT), options.maxKeyBytes ?? 512)
    this.client = client
    this.tableName = tableName
  }

  /** Creates the table and its expiry index when they do not exist. */
  async migrate (): Promise<void> {
    for (const statement of postgresMigration(this.tableName).split(';')) {
      if (statement.trim() !== '') await this.client.query(statement)
    }
  }
}
