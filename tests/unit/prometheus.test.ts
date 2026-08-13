import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { Registry } from 'prom-client'

import { Idempotency } from '../../src/index'
import type { IdempotencyStorage } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { prometheusMetrics } from '../../src/prometheus/index'

async function metricValue (registry: Registry, name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await registry.getMetricsAsJSON()
  // Histogram series (_count, _sum, _bucket) live inside the parent metric
  // with their own metricName per value entry.
  const metric = metrics.find((entry) => name === entry.name || name.startsWith(`${entry.name}_`))
  if (metric === undefined) return 0
  const values = metric.values as Array<{ value: number, metricName?: string, labels: Record<string, string | number> }>
  const match = values.find((candidate) =>
    (candidate.metricName ?? metric.name) === name &&
    Object.entries(labels).every(([label, value]) => String(candidate.labels[label]) === value)
  )
  return match?.value ?? 0
}

describe('prometheus collector', () => {
  test('counts executions by outcome and observes durations', async () => {
    const registry = new Registry()
    const idempotency = new Idempotency({
      storage: new MemoryStorage(),
      namespace: 'payments',
      metrics: prometheusMetrics({ register: registry })
    })

    await idempotency.execute('k', async () => { await sleep(20); return 'v' })
    await idempotency.execute('k', async () => 'v')
    await assert.rejects(idempotency.execute('fails', async () => { throw new Error('x') }), /x/)

    assert.equal(await metricValue(registry, 'quayside_executions_total', { outcome: 'completed', namespace: 'payments' }), 1)
    assert.equal(await metricValue(registry, 'quayside_executions_total', { outcome: 'replayed', namespace: 'payments' }), 1)
    assert.equal(await metricValue(registry, 'quayside_executions_total', { outcome: 'failed', namespace: 'payments' }), 1)
    assert.equal(await metricValue(registry, 'quayside_execution_duration_seconds_count', { outcome: 'completed', namespace: 'payments' }), 1)
    const sum = await metricValue(registry, 'quayside_execution_duration_seconds_sum', { outcome: 'completed', namespace: 'payments' })
    assert.ok(sum >= 0.015, `expected the completed duration to include the sleep, got ${sum}`)
  })

  test('counts conflicts and storage bypasses', async () => {
    const registry = new Registry()
    const collector = prometheusMetrics({ register: registry, prefix: 'q2_' })

    const gatedStorage = new MemoryStorage()
    const idempotency = new Idempotency({ storage: gatedStorage, metrics: collector })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = idempotency.execute('k', async () => { await gate; return 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 2))
    release()
    await running

    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const open = new Idempotency({ storage: down, onStorageError: 'open', metrics: collector })
    await open.execute('k', async () => 'v')

    assert.equal(await metricValue(registry, 'q2_conflicts_total', { namespace: '' }), 1)
    assert.equal(await metricValue(registry, 'q2_storage_bypass_total', { namespace: '' }), 1)
  })

  test('defaults and duration-less events are handled', async () => {
    const registry = new Registry()
    const collector = prometheusMetrics({ register: registry, prefix: 'q3_', durationBuckets: [0.1, 1] })
    const event = { type: 'completed', key: 'k', correlationId: 'c', timestamp: Date.now() } as const
    collector.onCompleted?.(event) // no durationMs: counted, not observed
    assert.equal(await metricValue(registry, 'q3_executions_total', { outcome: 'completed', namespace: '' }), 1)
    assert.equal(await metricValue(registry, 'q3_execution_duration_seconds_count', { outcome: 'completed', namespace: '' }), 0)

    // The global-registry default only needs to not throw.
    const globalCollector = prometheusMetrics()
    globalCollector.onConflict?.({ ...event, type: 'conflict' })
  })
})
