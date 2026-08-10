import { SerializationError } from './errors'

export interface Codec {
  encode (value: unknown): string
  decode (encoded: string): unknown
}

// Bare `undefined` is not valid JSON, so it can never collide with the
// encoding of any real value (the string 'undefined' encodes to
// '"undefined"').
const UNDEFINED_TOMBSTONE = 'undefined'

// JSON.stringify silently drops or mangles these (omitted properties,
// NaN turned into null): a stored result that differs from what the
// function returned is a silent correctness bug, so encoding fails loudly
// instead.
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
  return value
}

export const jsonCodec: Codec = {
  encode (value) {
    if (value === undefined) return UNDEFINED_TOMBSTONE
    try {
      return JSON.stringify(value, (_key, nested: unknown) => assertReplaceable(nested))
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
