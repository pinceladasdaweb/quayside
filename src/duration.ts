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
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new RangeError(`invalid duration ${duration}; expected a positive number of milliseconds`)
    }
    return Math.round(duration)
  }
  const match = DURATION_PATTERN.exec(duration)
  if (match === null) {
    throw new TypeError(`invalid duration "${duration}"; expected a positive number of milliseconds or a string like "500ms", "30s", "10m", "24h" or "7d"`)
  }
  // The pattern guarantees both groups; NaN from a hypothetical mismatch
  // still lands in the guard below.
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`invalid duration "${duration}"; it must be greater than zero`)
  }
  return Math.round(ms)
}
