import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold across entry points, so the
// build maps '../index' onto the shipped core bundle instead of inlining a
// private copy.
import { FencingError, RECORD_STATUS, StorageCorruptError } from '../index'
import type { IdempotencyStorage, Outcome, PendingRecord, RecordStatus, StoredRecord } from '../index'
// Plain shared constants carry no identity requirement, so unlike the
// errors above they may come straight from the module that defines them.
import { MAX_ACQUIRE_ATTEMPTS, VALID_STATUS } from '../storage'

/**
 * Minimal ioredis-shaped command surface. Structural on purpose: any
 * ioredis instance (standalone, sentinel or cluster) satisfies it without
 * quayside declaring a dependency on a specific driver version.
 */
export interface RedisCommandClient {
  options?: { db?: number, keyPrefix?: string }
  set (key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>
  get (key: string): Promise<string | null>
  del (...keys: string[]): Promise<number>
  eval (script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  /**
   * Optional. When present, fenced transitions send a 40-byte digest
   * instead of the whole script body; a server that forgot the script
   * answers NOSCRIPT and the adapter falls back to `eval`, which caches it
   * again. Every ioredis-shaped driver has it.
   */
  evalsha? (sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  duplicate? (): RedisSubscriberClient
}

export interface RedisSubscriberClient {
  subscribe (...channels: string[]): Promise<unknown>
  unsubscribe (...channels: string[]): Promise<unknown>
  on (event: 'message', listener: (channel: string, message: string) => void): unknown
  quit (): Promise<unknown>
  disconnect? (): void
}

/**
 * The `@pinceladasdaweb/redis` RedisClient shape: raw driver behind
 * `.client`, pub/sub on a dedicated connection that survives reconnects.
 */
export interface ManagedRedisClient {
  client: RedisCommandClient | null
  subscribe (channel: string, handler?: (message: string, channel: string, pattern?: string) => void | Promise<void>): Promise<unknown>
  unsubscribe (channel: string): Promise<unknown>
}

export type RedisStorageClient = RedisCommandClient | ManagedRedisClient

export interface RedisStorageOptions {
  /**
   * Use keyspace notifications to wake waiters early (requires
   * `notify-keyspace-events` to include `K$gx` on the server; without it
   * waiters simply fall back to polling). Default: true.
   */
  subscribe?: boolean
}

// The stored value is one JSON string per key so `SET NX PX` is the whole
// acquire. Timestamps travel as strings because the fenced transitions
// re-encode the record with cjson inside Lua, and cjson's number precision
// must never be able to corrupt an epoch.
interface WireRecord {
  token: string
  status: string
  fingerprint?: string
  result?: string
  error?: string
  storedAt: string
  expiresAt: string
}

const FENCED_HEADER = `local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.token ~= ARGV[1] or record.status ~= '${RECORD_STATUS.inProgress}' then return 0 end`

const COMPLETE_SCRIPT = `${FENCED_HEADER}
record.status = ARGV[2]
if ARGV[2] == '${RECORD_STATUS.completed}' then record.result = ARGV[3] else record.error = ARGV[3] end
record.expiresAt = ARGV[4]
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[5])
return 1`

const RELEASE_SCRIPT = `${FENCED_HEADER}
redis.call('DEL', KEYS[1])
return 1`

const EXTEND_SCRIPT = `${FENCED_HEADER}
record.expiresAt = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[3])
return 1`

// Redis addresses a cached script by the SHA1 of its body, so the digests
// are computed here rather than round-tripped through SCRIPT LOAD.
const COMPLETE_SHA = sha1(COMPLETE_SCRIPT)
const RELEASE_SHA = sha1(RELEASE_SCRIPT)
const EXTEND_SHA = sha1(EXTEND_SCRIPT)

// How long a keyspace subscription outlives its last waiter. Longer than
// the wait loop's polling backoff, so consecutive polls reuse it.
const SUBSCRIPTION_LINGER_MS = 5_000

function sha1 (script: string): string {
  return createHash('sha1').update(script).digest('hex')
}

// A server that restarted, was SCRIPT FLUSHed, or a replica that never saw
// the script answers NOSCRIPT. Anything else is a real failure.
function isNoScript (error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT')
}

function isManagedClient (client: RedisStorageClient): client is ManagedRedisClient {
  return 'client' in client && typeof (client as { client: unknown }).client !== 'function'
}

function parseWireRecord (key: string, raw: string): StoredRecord {
  const wire = JSON.parse(raw) as Partial<WireRecord>
  if (typeof wire.token !== 'string' || typeof wire.status !== 'string' || !VALID_STATUS.has(wire.status)) {
    throw new StorageCorruptError(key, `corrupt idempotency record under key "${key}"`)
  }
  const record: StoredRecord = {
    token: wire.token,
    status: wire.status as RecordStatus,
    storedAt: Number(wire.storedAt),
    expiresAt: Number(wire.expiresAt)
  }
  if (typeof wire.fingerprint === 'string') record.fingerprint = wire.fingerprint
  if (typeof wire.result === 'string') record.result = wire.result
  if (typeof wire.error === 'string') record.error = wire.error
  return record
}

/**
 * Redis storage adapter: `SET NX PX` acquire (the atomic write is the
 * lock) and Lua-fenced complete/release/extend, so every transition is
 * atomic on the server and a stale holder can never overwrite a newer
 * execution. Single-instance/cluster `SET NX` is the documented guarantee;
 * this is not Redlock.
 */
export class RedisStorage implements IdempotencyStorage {
  private readonly managed: ManagedRedisClient | undefined
  private readonly rawClient: RedisCommandClient | undefined
  private subscribeEnabled: boolean
  private ownedSubscriber: RedisSubscriberClient | undefined
  private readonly subscribedChannels = new Map<string, Promise<unknown>>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly lingering = new Map<string, ReturnType<typeof setTimeout>>()

  constructor (client: RedisStorageClient, options: RedisStorageOptions = {}) {
    if (isManagedClient(client)) {
      this.managed = client
    } else {
      this.rawClient = client
    }
    this.subscribeEnabled = options.subscribe ?? true
  }

  async acquire (record: PendingRecord, lockTtlMs: number): Promise<StoredRecord | null> {
    const wire: WireRecord = {
      token: record.token,
      status: RECORD_STATUS.inProgress,
      storedAt: String(record.storedAt),
      expiresAt: String(Date.now() + lockTtlMs)
    }
    if (record.fingerprint !== undefined) wire.fingerprint = record.fingerprint
    const encoded = JSON.stringify(wire)
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const outcome = await this.raw().set(record.key, encoded, 'PX', lockTtlMs, 'NX')
      if (outcome === 'OK') return null
      const current = await this.raw().get(record.key)
      if (current !== null) return parseWireRecord(record.key, current)
      // The holder expired between SET NX and GET: contend again.
    }
    throw new StorageCorruptError(record.key, `could not acquire or observe key "${record.key}" after ${MAX_ACQUIRE_ATTEMPTS} attempts`)
  }

  async complete (key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const payload = outcome.status === 'completed' ? outcome.result : outcome.error
    const applied = await this.runScript(
      COMPLETE_SCRIPT, COMPLETE_SHA, key,
      token, outcome.status, payload, String(Date.now() + resultTtlMs), resultTtlMs
    )
    if (applied !== 1) throw new FencingError(key)
  }

  async release (key: string, token: string): Promise<void> {
    const applied = await this.runScript(RELEASE_SCRIPT, RELEASE_SHA, key, token)
    if (applied !== 1) throw new FencingError(key)
  }

  async extend (key: string, token: string, lockTtlMs: number): Promise<void> {
    const applied = await this.runScript(
      EXTEND_SCRIPT, EXTEND_SHA, key,
      token, String(Date.now() + lockTtlMs), lockTtlMs
    )
    if (applied !== 1) throw new FencingError(key)
  }

  async get (key: string): Promise<StoredRecord | null> {
    const current = await this.raw().get(key)
    return current === null ? null : parseWireRecord(key, current)
  }

  async delete (key: string): Promise<void> {
    await this.raw().del(key)
  }

  async waitForChange (key: string, timeoutMs: number): Promise<void> {
    if (!this.subscribeEnabled) {
      await sleep(timeoutMs)
      return
    }
    let channel: string
    try {
      channel = await this.ensureSubscribed(key)
    } catch {
      // No subscription support (no duplicate(), subscribe refused):
      // degrade permanently to plain polling.
      this.subscribeEnabled = false
      await sleep(timeoutMs)
      return
    }
    await new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer)
        this.waiters.get(channel)?.delete(waiter)
        resolve()
      }
      const timer = setTimeout(waiter, timeoutMs)
      let channelWaiters = this.waiters.get(channel)
      if (channelWaiters === undefined) {
        channelWaiters = new Set()
        this.waiters.set(channel, channelWaiters)
      }
      channelWaiters.add(waiter)
    })
    this.releaseChannel(channel)
  }

  /** Unsubscribes and disposes any subscriber connection this adapter owns. */
  async close (): Promise<void> {
    for (const waiterSet of this.waiters.values()) {
      for (const waiter of [...waiterSet]) waiter()
    }
    this.waiters.clear()
    for (const timer of this.lingering.values()) clearTimeout(timer)
    this.lingering.clear()
    const channels = [...this.subscribedChannels.keys()]
    this.subscribedChannels.clear()
    if (this.ownedSubscriber !== undefined) {
      const subscriber = this.ownedSubscriber
      this.ownedSubscriber = undefined
      try {
        await subscriber.quit()
      } catch {
        subscriber.disconnect?.()
      }
      return
    }
    if (this.managed !== undefined) {
      for (const channel of channels) {
        try {
          await this.managed.unsubscribe(channel)
        } catch {}
      }
    }
  }

  /**
   * Sends the digest when the driver supports EVALSHA, and the body when it
   * does not or when the server has forgotten the script. Every fenced
   * transition goes through here, so the script text leaves the process at
   * most once per server lifetime instead of once per call.
   */
  private async runScript (
    script: string,
    sha: string,
    key: string,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const client = this.raw()
    if (typeof client.evalsha === 'function') {
      try {
        return await client.evalsha(sha, 1, key, ...args)
      } catch (error) {
        if (!isNoScript(error)) throw error
      }
    }
    return await client.eval(script, 1, key, ...args)
  }

  private raw (): RedisCommandClient {
    if (this.managed !== undefined) {
      const client = this.managed.client
      if (client === null) {
        throw new Error('the RedisClient is not connected; call connect() before using RedisStorage')
      }
      return client
    }
    return this.rawClient as RedisCommandClient
  }

  private channelFor (key: string): string {
    const options = this.raw().options
    const db = options?.db ?? 0
    const prefix = options?.keyPrefix ?? ''
    return `__keyspace@${db}__:${prefix}${key}`
  }

  private async ensureSubscribed (key: string): Promise<string> {
    const channel = this.channelFor(key)
    const linger = this.lingering.get(channel)
    if (linger !== undefined) {
      clearTimeout(linger)
      this.lingering.delete(channel)
    }
    let subscription = this.subscribedChannels.get(channel)
    if (subscription === undefined) {
      subscription = this.subscribeTo(channel)
      this.subscribedChannels.set(channel, subscription)
    }
    try {
      await subscription
    } catch (error) {
      this.subscribedChannels.delete(channel)
      throw error
    }
    return channel
  }

  private async subscribeTo (channel: string): Promise<unknown> {
    if (this.managed !== undefined) {
      return this.managed.subscribe(channel, (_message, notified) => {
        this.notify(notified ?? channel)
      })
    }
    const subscriber = this.subscriber()
    return subscriber.subscribe(channel)
  }

  private subscriber (): RedisSubscriberClient {
    if (this.ownedSubscriber !== undefined) return this.ownedSubscriber
    const raw = this.raw()
    if (typeof raw.duplicate !== 'function') {
      throw new Error('this client cannot open a subscriber connection')
    }
    const subscriber = raw.duplicate()
    subscriber.on('message', (channel) => {
      this.notify(channel)
    })
    this.ownedSubscriber = subscriber
    return subscriber
  }

  private notify (channel: string): void {
    const channelWaiters = this.waiters.get(channel)
    if (channelWaiters === undefined) return
    for (const waiter of [...channelWaiters]) waiter()
  }

  /**
   * The last waiter for a key leaves the subscription warm for a moment
   * instead of tearing it down: a poll loop comes back within its own
   * backoff, and unsubscribing between iterations would spend a round-trip
   * each time to save an idle subscription that costs the server nothing.
   */
  private releaseChannel (channel: string): void {
    if ((this.waiters.get(channel)?.size ?? 0) > 0) return
    this.waiters.delete(channel)
    if (this.lingering.has(channel)) return
    const timer = setTimeout(() => {
      this.lingering.delete(channel)
      // unsubscribeFrom swallows its own failures; nothing awaits this.
      this.unsubscribeFrom(channel).catch(() => {})
    }, SUBSCRIPTION_LINGER_MS)
    // Never a reason to hold the process open.
    timer.unref?.()
    this.lingering.set(channel, timer)
  }

  private async unsubscribeFrom (channel: string): Promise<void> {
    if (!this.subscribedChannels.delete(channel)) return
    try {
      if (this.managed !== undefined) {
        await this.managed.unsubscribe(channel)
      } else if (this.ownedSubscriber !== undefined) {
        await this.ownedSubscriber.unsubscribe(channel)
      }
    } catch {
      // Best-effort: a failed unsubscribe only costs an idle subscription.
    }
  }
}
