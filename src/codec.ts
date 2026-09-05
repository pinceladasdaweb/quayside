import { SerializationError } from './errors'

export interface Codec {
  encode (value: unknown): string
  decode (encoded: string): unknown
}

// Bare `undefined` is not valid JSON, so it can never collide with the
// encoding of any real value (the string 'undefined' encodes to
// '"undefined"').
const UNDEFINED_TOMBSTONE = 'undefined'

// Objects whose JSON form is not their value: no toJSON to catch, no own
// enumerable keys to speak of (or index keys that lose the type), so
// JSON.stringify quietly turns them into `{}` or an index object and the
// replay hands back something the function never returned. Buffer is
// absent from the list only because its own toJSON already trips the
// conversion check. Every test here is false for primitives and null, so
// the caller needs no object guard in front.
function isLossyInJson (value: unknown): boolean {
  return value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof RegExp ||
    value instanceof Promise ||
    value instanceof Error
}

// JSON.stringify silently drops or mangles these (omitted properties,
// NaN turned into null, collections turned into `{}`): a stored result
// that differs from what the function returned is a silent correctness
// bug, so encoding fails loudly instead.
function assertReplaceable (value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SerializationError(`value of type ${typeof value} is not JSON-serializable`)
  }
  if (typeof value === 'bigint') {
    throw new SerializationError('bigint values are not JSON-serializable')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SerializationError(`non-finite number ${value} is not JSON-serializable`)
  }
  if (value === undefined) {
    throw new SerializationError('nested undefined values are not JSON-serializable; only a top-level undefined result is supported')
  }
  if (isLossyInJson(value)) {
    // Every shape on the list is a built-in class instance, so the
    // constructor name is always there to blame.
    const name = (value as { constructor: { name: string } }).constructor.name
    throw new SerializationError(`${name} values are not JSON-serializable: JSON would store them as an empty or index object, not as the value the function returned; convert them to plain arrays or objects first`)
  }
  return value
}

// JSON.stringify runs a value's own toJSON before the replacer, so the
// replacer alone only ever sees the converted output and would wave the
// transformation through. The holder (`this` in a non-arrow replacer)
// still carries the original, which is where the conversion is caught.
// Dates are the one accepted conversion: storing a date as its ISO
// instant is what every JSON consumer expects. Anything else carrying a
// toJSON (a Buffer, an ORM entity) would silently replay as a different
// value than the function returned.
function assertNotConverted (original: unknown): void {
  if (original === null || (typeof original !== 'object' && typeof original !== 'function')) return
  if (original instanceof Date) return
  if (typeof (original as { toJSON?: unknown }).toJSON !== 'function') return
  const name = (original as { constructor?: { name?: string } }).constructor?.name ?? 'toJSON-bearing'
  throw new SerializationError(`${name} values carry a toJSON conversion, so what is stored would silently differ from what the function returned; convert the value explicitly or configure a codec that supports it`)
}

export const jsonCodec: Codec = {
  encode (value) {
    if (value === undefined) return UNDEFINED_TOMBSTONE
    try {
      return JSON.stringify(value, function (this: Record<string, unknown>, key, nested: unknown) {
        assertNotConverted(this[key])
        return assertReplaceable(nested)
      })
    } catch (error) {
      if (error instanceof SerializationError) throw error
      throw new SerializationError('value is not JSON-serializable', { cause: error })
    }
  },

  decode (encoded) {
    if (encoded === UNDEFINED_TOMBSTONE) return undefined
    try {
      return JSON.parse(encoded)
    } catch (error) {
      throw new SerializationError('stored value is not valid JSON', { cause: error })
    }
  }
}
