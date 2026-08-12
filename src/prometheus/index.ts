import { Counter, Histogram, register as defaultRegistry } from 'prom-client'
import type { Registry } from 'prom-client'

import type { IdempotencyEvent, MetricsCollector } from '../index'

export interface PrometheusMetricsOptions {
  /** prom-client registry receiving the metrics. Default: the global one. */
  register?: Registry
  /** Metric name prefix. Default: 'quayside_'. */
  prefix?: string
  /** Buckets for the duration histogram, in seconds. */
  durationBuckets?: number[]
}

const DEFAULT_BUCKETS = [0.005, 0.025, 0.1, 0.25, 1, 2.5, 10, 30]

/**
 * A MetricsCollector backed by prom-client. Create it once per registry and
 * pass it as the `metrics` option of one or more Idempotency instances;
 * the `namespace` label keeps them apart.
 *
 * Replay ratio in PromQL:
 *   sum(rate(quayside_executions_total{outcome="replayed"}[5m]))
 *     / sum(rate(quayside_executions_total[5m]))
 */
export function prometheusMetrics (options: PrometheusMetricsOptions = {}): MetricsCollector {
  const registry = options.register ?? defaultRegistry
  const prefix = options.prefix ?? 'quayside_'

  const executions = new Counter({
    name: `${prefix}executions_total`,
    help: 'Idempotent executions by terminal outcome (completed, replayed, failed).',
    labelNames: ['outcome', 'namespace'],
    registers: [registry]
  })
  const conflicts = new Counter({
    name: `${prefix}conflicts_total`,
    help: 'Calls that found their key already executing.',
    labelNames: ['namespace'],
    registers: [registry]
  })
  const bypasses = new Counter({
    name: `${prefix}storage_bypass_total`,
    help: 'Executions that ran without the exactly-once guarantee (onStorageError: open).',
    labelNames: ['namespace'],
    registers: [registry]
  })
  const duration = new Histogram({
    name: `${prefix}execution_duration_seconds`,
    help: 'Duration from execute() to the terminal outcome; replayed durations approximate the time a waiter spent blocked.',
    labelNames: ['outcome', 'namespace'],
    buckets: options.durationBuckets ?? DEFAULT_BUCKETS,
    registers: [registry]
  })

  const observe = (outcome: 'completed' | 'replayed' | 'failed') => (event: IdempotencyEvent) => {
    const namespace = event.namespace ?? ''
    executions.inc({ outcome, namespace })
    if (event.durationMs !== undefined) {
      duration.observe({ outcome, namespace }, event.durationMs / 1_000)
    }
  }

  return {
    onCompleted: observe('completed'),
    onReplayed: observe('replayed'),
    onFailed: observe('failed'),
    onConflict: (event) => conflicts.inc({ namespace: event.namespace ?? '' }),
    onStorageBypass: (event) => bypasses.inc({ namespace: event.namespace ?? '' })
  }
}
