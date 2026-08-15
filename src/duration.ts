export type Duration = number | string

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
} as const

export function parseDuration (duration: Duration): number {
  if (typeof duration === 'number') {
    // Rounding comes first: a positive value that rounds down to zero is not
    // a usable duration, since a zero TTL expires the instant it is written.
    const rounded = Math.round(duration)
    if (!Number.isFinite(rounded) || rounded <= 0) {
      throw new RangeError(`invalid duration ${duration}; expected a positive number of milliseconds`)
    }
    return rounded
  }
  const match = DURATION_PATTERN.exec(duration)
  if (match === null) {
    throw new TypeError(`invalid duration "${duration}"; expected a positive number of milliseconds or a string like "500ms", "30s", "10m", "24h" or "7d"`)
  }
  // The pattern guarantees both groups; NaN from a hypothetical mismatch
  // still lands in the guard below.
  const ms = Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS])
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`invalid duration "${duration}"; it must be greater than zero`)
  }
  return ms
}
