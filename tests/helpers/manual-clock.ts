import type { IdempotencyClock } from '../../src/index'

/**
 * Deterministic clock: now() is frozen until sleep() or advance() moves it,
 * and every sleep is recorded so tests can assert the exact backoff
 * sequence instead of racing wall time.
 */
export class ManualClock implements IdempotencyClock {
  time: number
  readonly sleeps: number[] = []

  constructor (start = 1_000_000) {
    this.time = start
  }

  now (): number {
    return this.time
  }

  async sleep (ms: number): Promise<void> {
    this.sleeps.push(ms)
    // A zero-length sleep still moves time forward, so a mutant that waits
    // on a spent deadline terminates instead of spinning forever.
    this.time += Math.max(ms, 1)
  }

  advance (ms: number): void {
    this.time += ms
  }
}
