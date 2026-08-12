import { SpanStatusCode, trace } from '@opentelemetry/api'
import type { Tracer } from '@opentelemetry/api'

import type { IdempotencyEvent, MetricsCollector } from '../index'

export interface OtelSpansOptions {
  /** Tracer used for the spans. Default: trace.getTracer('quayside'). */
  tracer?: Tracer
}

function attributesFor (event: IdempotencyEvent): Record<string, string | boolean> {
  const attributes: Record<string, string | boolean> = {
    'quayside.key': event.key,
    'quayside.correlation_id': event.correlationId
  }
  if (event.namespace !== undefined) attributes['quayside.namespace'] = event.namespace
  return attributes
}

/**
 * A MetricsCollector that turns the event stream into OpenTelemetry spans.
 * Events are emitted synchronously inside execute(), so spans parent to
 * whatever span is active at the call site, including breakwater's, when
 * its policies wrap the surrounding work.
 *
 * Spans are created at the terminal event with a backdated start, so a
 * crash never leaks an open span.
 */
export function otelSpans (options: OtelSpansOptions = {}): MetricsCollector {
  const tracer = options.tracer ?? trace.getTracer('quayside')
  const starts = new Map<string, number>()

  const terminal = (outcome: 'completed' | 'replayed' | 'failed') => (event: IdempotencyEvent) => {
    const acquiredAt = starts.get(event.correlationId)
    starts.delete(event.correlationId)
    const startTime = acquiredAt ?? (event.durationMs === undefined ? event.timestamp : event.timestamp - event.durationMs)
    const span = tracer.startSpan('quayside.execute', {
      startTime,
      attributes: {
        ...attributesFor(event),
        'quayside.outcome': outcome,
        'quayside.replayed': outcome === 'replayed'
      }
    })
    if (outcome === 'failed') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(event.timestamp)
  }

  const instant = (name: string) => (event: IdempotencyEvent) => {
    const span = tracer.startSpan(name, { startTime: event.timestamp, attributes: attributesFor(event) })
    span.end(event.timestamp)
  }

  return {
    onAcquired: (event) => {
      starts.set(event.correlationId, event.timestamp)
    },
    onCompleted: terminal('completed'),
    onReplayed: terminal('replayed'),
    onFailed: terminal('failed'),
    onConflict: instant('quayside.conflict'),
    onStorageBypass: instant('quayside.storage-bypass')
  }
}
