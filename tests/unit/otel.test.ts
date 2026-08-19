import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { SpanStatusCode, trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { Idempotency } from '../../src/index'
import type { IdempotencyStorage } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { otelSpans } from '../../src/otel/index'
import { ManualClock } from '../helpers/manual-clock'

function tracing () {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  return { exporter, provider, tracer: provider.getTracer('test') }
}

function hrTimeToMs (hrTime: [number, number]): number {
  return hrTime[0] * 1_000 + hrTime[1] / 1e6
}

describe('otel collector', () => {
  test('falls back to the global tracer and stays inert without an SDK', () => {
    const collector = otelSpans()
    const event = { type: 'completed', key: 'k', correlationId: 'c-1', timestamp: Date.now(), durationMs: 5 } as const
    collector.onAcquired?.({ ...event, type: 'acquired' })
    collector.onCompleted?.(event)
    collector.onReplayed?.({ ...event, type: 'replayed' })
    collector.onConflict?.({ ...event, type: 'conflict' })
    // No recorded start and no duration: the span degrades to instant.
    collector.onFailed?.({ type: 'failed', key: 'k', correlationId: 'c-2', timestamp: Date.now() })
  })

  test('emits execute spans with replay and outcome attributes', async () => {
    const { exporter, tracer } = tracing()
    const idempotency = new Idempotency({
      storage: new MemoryStorage(),
      namespace: 'payments',
      metrics: otelSpans({ tracer })
    })

    await idempotency.execute('k', async () => { await sleep(15); return 'v' })
    await idempotency.execute('k', async () => 'v')

    const spans = exporter.getFinishedSpans()
    assert.equal(spans.length, 2)
    const [fresh, replayed] = spans
    assert.ok(fresh && replayed)

    assert.equal(fresh.name, 'quayside.execute')
    assert.equal(fresh.attributes['quayside.outcome'], 'completed')
    assert.equal(fresh.attributes['quayside.replayed'], false)
    assert.equal(fresh.attributes['quayside.key'], 'k')
    assert.equal(fresh.attributes['quayside.namespace'], 'payments')
    const durationMs = (fresh.endTime[0] - fresh.startTime[0]) * 1_000 + (fresh.endTime[1] - fresh.startTime[1]) / 1e6
    assert.ok(durationMs >= 10, `expected the span to cover the sleep, got ${durationMs}ms`)

    assert.equal(replayed.attributes['quayside.replayed'], true)
    assert.equal(replayed.attributes['quayside.correlation_id'] === fresh.attributes['quayside.correlation_id'], false)
  })

  test('the default tracer registers under the quayside scope', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    trace.setGlobalTracerProvider(provider)
    try {
      const idempotency = new Idempotency({ storage: new MemoryStorage(), metrics: otelSpans() })
      await idempotency.execute('k', async () => 'v')
      const spans = exporter.getFinishedSpans()
      assert.equal(spans[0]?.instrumentationScope.name, 'quayside')
    } finally {
      trace.disable()
    }
  })

  test('span timestamps come from the engine clock, exactly', async () => {
    const { exporter, tracer } = tracing()
    const clock = new ManualClock(50_000)
    const memory = new MemoryStorage({ now: () => clock.now() })
    // The acquire itself takes 30ms of clock time: the span must start at
    // the acquired instant, not at the execute() call.
    const storage: IdempotencyStorage = {
      acquire: async (record, ttl) => { clock.advance(30); return memory.acquire(record, ttl) },
      complete: (key, token, outcome, ttl) => memory.complete(key, token, outcome, ttl),
      release: (key, token) => memory.release(key, token),
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const idempotency = new Idempotency({ storage, clock, metrics: otelSpans({ tracer }) })

    await idempotency.execute('k', async () => {
      clock.advance(500)
      return 'v'
    })
    const fresh = exporter.getFinishedSpans()[0]
    assert.ok(fresh)
    assert.equal(hrTimeToMs(fresh.startTime), 50_030)
    assert.equal(hrTimeToMs(fresh.endTime), 50_530)

    clock.advance(70)
    await idempotency.execute('k', async () => 'never')
    const replayed = exporter.getFinishedSpans()[1]
    assert.ok(replayed)
    assert.equal(replayed.attributes['quayside.replayed'], true)
    // The replay span covers the acquire round-trip: 30ms of clock time.
    assert.equal(hrTimeToMs(replayed.endTime) - hrTimeToMs(replayed.startTime), 30)
    assert.equal(hrTimeToMs(replayed.endTime), 50_630)
  })

  test('a terminal event without an acquire or a duration degrades to an instant span', async () => {
    const { exporter, tracer } = tracing()
    const collector = otelSpans({ tracer })
    collector.onCompleted?.({ type: 'completed', key: 'k', correlationId: 'solo', timestamp: 80_000 })
    const span = exporter.getFinishedSpans()[0]
    assert.ok(span)
    assert.equal(hrTimeToMs(span.startTime), 80_000, 'no duration to backdate with: the span starts at the event')
    assert.equal(hrTimeToMs(span.endTime), 80_000)
  })

  test('waiter replays backdate the span across the blocked window', async () => {
    const { exporter, tracer } = tracing()
    const idempotency = new Idempotency({
      storage: new MemoryStorage(),
      onConflict: 'wait',
      metrics: otelSpans({ tracer })
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const winner = idempotency.execute('k', async () => { await gate; return 1 })
    await new Promise((resolve) => setImmediate(resolve))
    const waiter = idempotency.execute('k', async () => 2)
    setTimeout(release, 60)
    await winner
    await waiter

    const replaySpan = exporter.getFinishedSpans().find((span) => span.attributes['quayside.replayed'] === true)
    assert.ok(replaySpan)
    const duration = hrTimeToMs(replaySpan.endTime) - hrTimeToMs(replaySpan.startTime)
    assert.ok(duration >= 20, `the waiter blocked for ~60ms, the span must cover it (got ${duration}ms)`)
  })

  test('spans without a namespace omit the attribute entirely', async () => {
    const { exporter, tracer } = tracing()
    const idempotency = new Idempotency({ storage: new MemoryStorage(), metrics: otelSpans({ tracer }) })
    await idempotency.execute('k', async () => 'v')
    const span = exporter.getFinishedSpans()[0]
    assert.ok(span)
    assert.ok(!('quayside.namespace' in span.attributes))
    assert.notEqual(span.status.code, SpanStatusCode.ERROR)
  })

  test('a storage bypass consumes the recorded start instead of leaking it', async () => {
    // Fail-open with a storage that dies on the completion write emits
    // 'acquired' then 'storage-bypass' and no terminal event: the recorded
    // start must not outlive the execution that registered it.
    const { exporter, tracer } = tracing()
    const collector = otelSpans({ tracer })
    const base = { key: 'k', correlationId: 'c-bypass' } as const
    collector.onAcquired?.({ ...base, type: 'acquired', timestamp: 1_000 })
    collector.onStorageBypass?.({ ...base, type: 'storage-bypass', timestamp: 1_100 })
    collector.onCompleted?.({ ...base, type: 'completed', timestamp: 2_000, durationMs: 50 })

    const executeSpan = exporter.getFinishedSpans().find((span) => span.name === 'quayside.execute')
    assert.ok(executeSpan)
    assert.equal(hrTimeToMs(executeSpan.startTime), 1_950, 'a stale start would backdate this span to 1000')
  })

  test('a terminal event consumes the recorded start instead of leaking it', async () => {
    // Same probe as the bypass case: once a terminal event used the start,
    // a later event carrying the same correlation id must fall back to its
    // own duration instead of backdating to the stale start.
    const { exporter, tracer } = tracing()
    const collector = otelSpans({ tracer })
    const base = { key: 'k', correlationId: 'c-terminal' } as const
    collector.onAcquired?.({ ...base, type: 'acquired', timestamp: 1_000 })
    collector.onCompleted?.({ ...base, type: 'completed', timestamp: 2_000 })
    collector.onCompleted?.({ ...base, type: 'completed', timestamp: 3_000, durationMs: 50 })

    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'quayside.execute')
    assert.equal(spans.length, 2)
    assert.equal(hrTimeToMs(spans[1]!.startTime), 2_950, 'a stale start would backdate this span to 1000')
  })

  test('expired recoveries emit their own span', async () => {
    const { exporter, tracer } = tracing()
    const collector = otelSpans({ tracer })
    collector.onExpiredRecovery?.({ type: 'expired-recovery', key: 'k', correlationId: 'c-exp', timestamp: 1_000 })
    assert.ok(exporter.getFinishedSpans().some((span) => span.name === 'quayside.expired-recovery'))
  })

  test('storage bypasses emit their own span', async () => {
    const { exporter, tracer } = tracing()
    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const idempotency = new Idempotency({ storage: down, onStorageError: 'open', metrics: otelSpans({ tracer }) })
    await idempotency.execute('k', async () => 'v')
    assert.ok(exporter.getFinishedSpans().some((span) => span.name === 'quayside.storage-bypass'))
  })

  test('marks failed executions and emits conflict spans', async () => {
    const { exporter, tracer } = tracing()
    const idempotency = new Idempotency({ storage: new MemoryStorage(), metrics: otelSpans({ tracer }) })

    await assert.rejects(idempotency.execute('fails', async () => { throw new Error('x') }), /x/)

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = idempotency.execute('k', async () => { await gate; return 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(idempotency.execute('k', async () => 2))
    release()
    await running

    const spans = exporter.getFinishedSpans()
    const failed = spans.find((span) => span.attributes['quayside.outcome'] === 'failed')
    assert.ok(failed)
    assert.equal(failed.status.code, SpanStatusCode.ERROR)
    const conflict = spans.find((span) => span.name === 'quayside.conflict')
    assert.ok(conflict)
    assert.equal(conflict.attributes['quayside.key'], 'k')
  })
})
