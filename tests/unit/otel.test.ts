import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { otelSpans } from '../../src/otel/index'

function tracing () {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  return { exporter, tracer: provider.getTracer('test') }
}

describe('otel collector', () => {
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
