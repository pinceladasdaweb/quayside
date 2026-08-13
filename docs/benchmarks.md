# Benchmarks

What does the guarantee cost? `npm run bench` measures the overhead
`execute()` adds over calling the function directly, per storage, for the
two hot paths:

- **miss** — a fresh execution: acquire + run + fenced complete (two
  storage round-trips).
- **hit** — a replay: the acquire finds the completed record (one storage
  round-trip).

```bash
npm run bench            # memory only, no Docker needed
npm run bench -- all     # + redis, postgres, mysql via Testcontainers
```

## Indicative numbers

Apple Silicon laptop, Node 26, backends in local Docker (network latency
near zero — real deployments pay their own RTT on top). Sequential calls,
10% warmup. Treat the *relationships* as the signal, not the absolutes:

| storage | scenario | us/op | ops/s |
|---|---|---:|---:|
| (bare fn) | baseline | 0.1 | ~19,600,000 |
| memory | miss (acquire + run + complete) | 2.6 | ~388,000 |
| memory | hit (replay) | 0.9 | ~1,146,000 |
| redis | miss | 221 | ~4,500 |
| redis | hit | 184 | ~5,400 |
| postgres | miss | 2,163 | ~460 |
| postgres | hit | 503 | ~2,000 |
| mysql | miss | 5,567 | ~180 |
| mysql | hit | 573 | ~1,750 |

## How to read this

- **The abstraction itself costs ~2.6 us** (memory miss): state machine,
  token generation, codec, events. Everything above that is storage I/O.
- **A miss costs two round-trips, a hit costs one** — visible in every
  backend, most dramatically on SQL where the miss also pays the
  insert-contend-select dance and the write itself.
- **Replays are cheap.** The whole point of the library: the expensive
  path runs once, duplicates pay one read.
- **SQL miss cost is dominated by the write path** (Postgres ~2.2 ms,
  MySQL ~5.6 ms locally). For high-throughput consumers prefer the Redis
  adapter; SQL shines where the operational win is *no extra
  infrastructure* — the idempotency table lives next to your data.

Numbers are sequential per-operation latency; under concurrency the
backends pipeline far higher aggregate throughput.
