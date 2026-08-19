import { SpanStatusCode, trace } from '@opentelemetry/api'
import type { Attributes, Tracer } from '@opentelemetry/api'

import type { IdempotencyEvent, MetricsCollector } from '../index'

export interface OtelSpansOptions {
  /** Tracer used for the spans. Default: trace.getTracer('quayside'). */
  tracer?: Tracer
}

function attributesFor (event: IdempotencyEvent): Attributes {
  return {
    'quayside.key': event.key,
    'quayside.correlation_id': event.correlationId,
    // The Attributes contract allows undefined values and drops them, which
    // is exactly the omit-when-absent semantics wanted for the namespace.
    'quayside.namespace': event.namespace
  }
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
    onExpiredRecovery: instant('quayside.expired-recovery'),
    onStorageBypass: (event) => {
      // A bypass after a successful acquire is terminal: the completion write
      // failed once the function had already run, so no completed/failed
      // event follows and the recorded start would be kept forever.
      starts.delete(event.correlationId)
      instant('quayside.storage-bypass')(event)
    }
  }
}
