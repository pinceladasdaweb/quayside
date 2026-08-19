import type { SqlDialect, SqlRunner } from '../sql/core'
import { SqlStorageCore, assertSafeTableName, buildStatements } from '../sql/core'

export type { SqlRunResult, SqlRunner, SqlStatements } from '../sql/core'

/**
 * Minimal mysql2/promise-shaped surface. Structural on purpose: a mysql2
 * promise Pool or Connection satisfies it without quayside declaring a
 * driver dependency.
 */
export interface MysqlClientLike {
  query (sql: string, values?: unknown[]): Promise<[unknown, unknown]>
}

export interface MysqlStorageOptions {
  /** Table holding the records. Default: 'quayside_records'. */
  tableName?: string
  /** Byte capacity of the key column; longer keys are rejected. Default: 512. */
  maxKeyBytes?: number
}

const DEFAULT_TABLE = 'quayside_records'

/** The DDL executed by migrate(), for external migration tools. */
export function mysqlMigration (tableName: string = DEFAULT_TABLE): string {
  assertSafeTableName(tableName)
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  record_key VARCHAR(512) NOT NULL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  fingerprint TEXT NULL,
  result MEDIUMTEXT NULL,
  error MEDIUMTEXT NULL,
  stored_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX ${tableName}_expires_at (expires_at)
)`
}

const MYSQL_DIALECT: SqlDialect = {
  placeholder: () => '?',
  insertIfAbsent: (tableAndValues) => `INSERT IGNORE INTO ${tableAndValues}`
}

/**
 * MySQL storage adapter: INSERT IGNORE is the atomic acquire, expired rows
 * are reclaimed in place (lazy cleanup, no cron required) and every fenced
 * transition is one token-conditional UPDATE/DELETE, so atomicity lives in
 * the database. Keys longer than the column are rejected in the adapter,
 * never truncated, regardless of the server's sql_mode.
 */
export class MysqlStorage extends SqlStorageCore {
  private readonly client: MysqlClientLike
  private readonly tableName: string

  constructor (client: MysqlClientLike, options: MysqlStorageOptions = {}) {
    const tableName = options.tableName ?? DEFAULT_TABLE
    assertSafeTableName(tableName)
    const run: SqlRunner = async (sql, params) => {
      const [result] = await client.query(sql, params)
      if (Array.isArray(result)) {
        return { affected: 0, rows: result as Array<Record<string, unknown>> }
      }
      const header = result as { affectedRows?: number }
      return { affected: header.affectedRows ?? 0, rows: [] }
    }
    super(run, buildStatements(tableName, MYSQL_DIALECT), options.maxKeyBytes ?? 512)
    this.client = client
    this.tableName = tableName
  }

  /** Creates the table and its expiry index when they do not exist. */
  async migrate (): Promise<void> {
    await this.client.query(mysqlMigration(this.tableName))
  }
}
