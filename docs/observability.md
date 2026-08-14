# Observability

Every execution emits typed events; `quayside/prometheus` and
`quayside/otel` turn that stream into metrics and spans. The event
reference lives in [core.md](core.md#events-reference).

## Prometheus

```ts
import { Idempotency } from 'quayside'
import { prometheusMetrics } from 'quayside/prometheus'

const idempotency = new Idempotency({
  storage,
  namespace: 'payments',
  metrics: prometheusMetrics()   // optional: { register, prefix, durationBuckets }
})
```

Peer dependency: `prom-client`. Exposed metrics (default prefix `quayside_`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `quayside_executions_total` | counter | `outcome`, `namespace` | Terminal outcomes: `completed`, `replayed`, `failed` |
| `quayside_conflicts_total` | counter | `namespace` | Calls that found their key already executing |
| `quayside_storage_bypass_total` | counter | `namespace` | Unguarded executions (`onStorageError: 'open'`) — alert on this |
| `quayside_execution_duration_seconds` | histogram | `outcome`, `namespace` | Time from `execute()` to the terminal outcome; `replayed` durations approximate the time a waiter spent blocked |

Replay ratio in PromQL:

```promql
sum(rate(quayside_executions_total{outcome="replayed"}[5m]))
  / sum(rate(quayside_executions_total[5m]))
```

Create the collector once per registry (metric names may not be registered
twice) and share it across instances — the `namespace` label keeps them
apart.

## OpenTelemetry

```ts
import { otelSpans } from 'quayside/otel'

const idempotency = new Idempotency({ storage, metrics: otelSpans() })
```

Peer dependency: `@opentelemetry/api` (bring your own SDK setup). Spans:

- `quayside.execute` — one per terminal outcome, with attributes
  `quayside.key`, `quayside.namespace`, `quayside.correlation_id`,
  `quayside.outcome` and `quayside.replayed`; `failed` sets the span status
  to error. The span is created at the terminal event with a backdated
  start, so a crashed process never leaks an open span.
- `quayside.conflict` and `quayside.storage-bypass` — instant spans.

Events are emitted synchronously inside `execute()`, so spans parent to
whatever span is active at the call site. If a breakwater policy wraps the
surrounding work, quayside's spans nest under it automatically.

## correlationId and breakwater

Every event of one `execute()` call carries the same `correlationId`, under
the same field name and semantics as breakwater's execution events — log
pipelines can join the two streams directly, and the OTel span attribute
`quayside.correlation_id` carries it into traces.

## Rolling your own

`onEvent` receives every event; `metrics` receives them through named
methods (`onAcquired`, `onReplayed`, ...). Both are fire-and-forget:
a throwing listener never alters execution semantics — the exception is
reported as a process warning (`process.emitWarning`) naming the event
type, so a broken collector is visible without ever failing an operation.
