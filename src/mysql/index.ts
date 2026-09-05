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
  /**
   * Byte capacity of the key column; longer keys are rejected. Default:
   * 512. `migrate()` declares the column from this value, so the guard and
   * the column it protects can never disagree.
   */
  maxKeyBytes?: number
}

/**
 * The DDL executed by migrate(), for external migration tools. The key
 * column is sized from `maxKeyBytes` (characters, so at least that many
 * bytes under utf8mb4) and compared byte for byte: MySQL's default
 * collations are case- and accent-insensitive, and under one of those
 * `Key-1` and `key-1`, distinct keys on every other storage, would be one
 * row here, replaying one caller's response as another's.
 */
export function mysqlMigration (tableName: string = DEFAULT_TABLE, maxKeyBytes: number = DEFAULT_MAX_KEY_BYTES): string {
  assertSafeTableName(tableName)
  assertKeyCapacity(maxKeyBytes)
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  ${KEY_COLUMN} VARCHAR(${maxKeyBytes}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
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
    super(run, buildStatements(tableName, MYSQL_DIALECT), options.maxKeyBytes ?? DEFAULT_MAX_KEY_BYTES)
    this.client = client
    this.tableName = tableName
  }

  /** Creates the table and its expiry index when they do not exist. */
  async migrate (): Promise<void> {
    await this.client.query(mysqlMigration(this.tableName, this.maxKeyBytes))
  }
}
