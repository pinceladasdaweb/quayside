// Measures the overhead execute() adds over calling the function directly,
// per storage backend, for the two hot paths: a fresh execution (miss:
// acquire + run + complete) and a replay (hit: acquire finds the record).
//
//   npm run bench                # memory only
//   npm run bench -- all         # memory + redis + postgres + mysql (Docker)
//   npm run bench -- redis mysql # a subset
import { GenericContainer, Wait } from 'testcontainers'

import { Idempotency } from '../src/index'
import type { IdempotencyStorage } from '../src/index'
import { MemoryStorage } from '../src/memory/index'

interface Target {
  name: string
  storage: IdempotencyStorage
  iterations: number
  close (): Promise<void>
}

interface Row {
  target: string
  scenario: string
  microsPerOp: number
  opsPerSec: number
}

async function measure (iterations: number, operation: (iteration: number) => Promise<unknown>): Promise<{ microsPerOp: number, opsPerSec: number }> {
  const warmup = Math.max(1, Math.floor(iterations / 10))
  for (let iteration = 0; iteration < warmup; iteration += 1) await operation(iteration)
  const started = process.hrtime.bigint()
  for (let iteration = 0; iteration < iterations; iteration += 1) await operation(warmup + iteration)
  const elapsedNs = Number(process.hrtime.bigint() - started)
  return {
    microsPerOp: elapsedNs / iterations / 1_000,
    opsPerSec: iterations / (elapsedNs / 1e9)
  }
}

async function memoryTarget (): Promise<Target> {
  return { name: 'memory', storage: new MemoryStorage(), iterations: 20_000, close: async () => {} }
}

async function redisTarget (): Promise<Target> {
  const { RedisStorage } = await import('../src/redis/index')
  const { Redis } = await import('ioredis')
  const container = await new GenericContainer('redis:8-alpine').withExposedPorts(6379).start()
  const client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
  return {
    name: 'redis',
    storage: new RedisStorage(client, { subscribe: false }),
    iterations: 2_000,
    close: async () => {
      client.disconnect()
      await container.stop()
    }
  }
}

async function postgresTarget (): Promise<Target> {
  const { PostgresStorage } = await import('../src/postgres/index')
  const { default: pg } = await import('pg')
  const container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'bench', POSTGRES_DB: 'bench' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: 'postgres',
    password: 'bench',
    database: 'bench'
  })
  const storage = new PostgresStorage(pool)
  await storage.migrate()
  return {
    name: 'postgres',
    storage,
    iterations: 2_000,
    close: async () => {
      await pool.end()
      await container.stop()
    }
  }
}

async function mysqlTarget (): Promise<Target> {
  const { MysqlStorage } = await import('../src/mysql/index')
  const mysql = await import('mysql2/promise')
  const container = await new GenericContainer('mysql:8.4')
    .withEnvironment({ MYSQL_ROOT_PASSWORD: 'bench', MYSQL_DATABASE: 'bench' })
    .withExposedPorts(3306)
    .withHealthCheck({ test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-pbench'], interval: 1_000, timeout: 3_000, retries: 60 })
    .withWaitStrategy(Wait.forHealthCheck())
    .start()
  const pool = mysql.createPool({
    host: container.getHost(),
    port: container.getMappedPort(3306),
    user: 'root',
    password: 'bench',
    database: 'bench'
  })
  const storage = new MysqlStorage(pool)
  await storage.migrate()
  return {
    name: 'mysql',
    storage,
    iterations: 2_000,
    close: async () => {
      await pool.end()
      await container.stop()
    }
  }
}

const FACTORIES: Record<string, () => Promise<Target>> = {
  memory: memoryTarget,
  redis: redisTarget,
  postgres: postgresTarget,
  mysql: mysqlTarget
}

const requested = process.argv.slice(2)
const names = requested.length === 0
  ? ['memory']
  : requested.includes('all') ? Object.keys(FACTORIES) : requested

const rows: Row[] = []
const work = async (): Promise<string> => 'result'

const baseline = await measure(50_000, work)
rows.push({ target: '(bare fn)', scenario: 'baseline', ...baseline })

for (const name of names) {
  const factory = FACTORIES[name]
  if (factory === undefined) {
    console.error(`unknown backend "${name}"; expected: ${Object.keys(FACTORIES).join(', ')}, all`)
    process.exit(1)
  }
  const target = await factory()
  try {
    const idempotency = new Idempotency({ storage: target.storage, namespace: `bench-${Date.now()}` })

    const miss = await measure(target.iterations, (iteration) =>
      idempotency.execute(`miss:${iteration}`, work))
    rows.push({ target: target.name, scenario: 'miss (acquire + run + complete)', ...miss })

    await idempotency.execute('hit', work)
    const hit = await measure(target.iterations, () => idempotency.execute('hit', work))
    rows.push({ target: target.name, scenario: 'hit (replay)', ...hit })
  } finally {
    await target.close()
  }
}

console.log(`\nnode ${process.version}\n`)
console.log('| storage | scenario | us/op | ops/s |')
console.log('|---|---|---:|---:|')
for (const row of rows) {
  console.log(`| ${row.target} | ${row.scenario} | ${row.microsPerOp.toFixed(1)} | ${Math.round(row.opsPerSec).toLocaleString('en-US')} |`)
}
