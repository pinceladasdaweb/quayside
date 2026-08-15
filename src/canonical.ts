import { createHash, timingSafeEqual } from 'node:crypto'

import { SerializationError } from './errors'

export interface CanonicalizeOptions {
  /** Dot-separated paths removed from the payload before hashing. */
  ignoreFields?: string[]
  /** Dot-separated paths kept in the payload; everything else is removed. */
  pickFields?: string[]
}

// A prefix longer than the path fails every() naturally: the surplus
// segments compare against undefined.
function isPrefix (prefix: string[], path: string[]): boolean {
  return prefix.every((segment, index) => segment === path[index])
}

class PathFilter {
  private readonly ignore: Set<string>
  private readonly picks: string[][] | undefined

  constructor (options: CanonicalizeOptions) {
    this.ignore = new Set(options.ignoreFields ?? [])
    this.picks = options.pickFields?.map((path) => path.split('.'))
  }

  // Only called for object entries and array items, whose paths are never
  // empty; the root value is always included.
  includes (path: string[]): boolean {
    if (this.ignore.has(path.join('.'))) return false
    if (this.picks === undefined) return true
    return this.picks.some((pick) => isPrefix(pick, path) || isPrefix(path, pick))
  }
}

// Canonical, type-tagged stringify: independent of key insertion order,
// machine and locale, and safe against prototype-pollution shapes (only own
// enumerable keys are read; an own '__proto__' key is treated as plain
// data). Type tags keep values JSON would conflate apart (1 vs '1', array
// vs object). Values that cannot be canonicalized deterministically fail
// loudly instead of hashing to a colliding representation.
function canonicalizeValue (value: unknown, path: string[], filter: PathFilter, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const type = typeof value
  if (type === 'boolean') return `bool:${String(value)}`
  // String(-0) is already '0': negative zero normalizes for free.
  if (type === 'number') return `num:${String(value)}`
  if (type === 'bigint') return `bigint:${String(value)}`
  if (type === 'string') return `str:${JSON.stringify(value)}`
  if (type === 'function' || type === 'symbol') {
    throw new SerializationError(`values of type ${type} cannot be fingerprinted`)
  }

  const object = value as object
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'date:invalid' : `date:${object.toISOString()}`
  }
  if (ArrayBuffer.isView(object)) {
    return `bytes:${Buffer.from(object.buffer, object.byteOffset, object.byteLength).toString('hex')}`
  }
  // Raw buffers carry no own enumerable keys: without this branch they would
  // canonicalize as an empty object and every binary payload would collide.
  if (object instanceof ArrayBuffer || object instanceof SharedArrayBuffer) {
    return `bytes:${Buffer.from(object).toString('hex')}`
  }
  if (object instanceof Map || object instanceof Set || object instanceof RegExp) {
    throw new SerializationError(`${object.constructor.name} values cannot be fingerprinted; convert them to plain arrays or objects first`)
  }

  if (seen.has(object)) {
    throw new SerializationError('circular references cannot be fingerprinted')
  }
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      const items: string[] = []
      for (let index = 0; index < object.length; index += 1) {
        const itemPath = [...path, String(index)]
        if (!filter.includes(itemPath)) continue
        items.push(canonicalizeValue(object[index], itemPath, filter, seen))
      }
      return `arr:[${items.join(',')}]`
    }
    const keys = Object.keys(object).sort()
    const entries: string[] = []
    for (const key of keys) {
      const entryPath = [...path, key]
      if (!filter.includes(entryPath)) continue
      const entryValue = (object as Record<string, unknown>)[key]
      entries.push(`${JSON.stringify(key)}:${canonicalizeValue(entryValue, entryPath, filter, seen)}`)
    }
    return `obj:{${entries.join(',')}}`
  } finally {
    seen.delete(object)
  }
}

export function canonicalize (value: unknown, options: CanonicalizeOptions = {}): string {
  return canonicalizeValue(value, [], new PathFilter(options), new WeakSet())
}

export function hashCanonical (value: unknown, options: CanonicalizeOptions = {}): string {
  return createHash('sha256').update(canonicalize(value, options)).digest('hex')
}

// Fingerprints are compared in constant time so the comparison never leaks
// how much of a fingerprint matched.
export function fingerprintsEqual (a: string | undefined, b: string | undefined): boolean {
  // A record without a fingerprint only matches a call without one; an
  // empty-string fingerprint is a real value and must not match absence.
  if ((a === undefined) !== (b === undefined)) return false
  const bufferA = Buffer.from(a ?? '')
  const bufferB = Buffer.from(b ?? '')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
