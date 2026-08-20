import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import Fastify, { type FastifyInstance } from 'fastify'

import { FastifyPlugin } from '../../src/fastify/index'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

// note: Fastify and the storage types are exercised structurally; the
// poisoned-record test below feeds the plugin a replayable failure.

let app: FastifyInstance
let calls: Record<string, number>

before(async () => {
  calls = {}
  const idempotency = new Idempotency({ storage: new MemoryStorage() })
  app = Fastify()
  await app.register(FastifyPlugin(idempotency, { maxBodyBytes: 1_024 }) as never)

  app.post('/payments', async (request, reply) => {
    calls.payments = (calls.payments ?? 0) + 1
    return reply.status(201).header('location', '/payments/9').send({ id: 9, amount: (request.body as { amount: number }).amount })
  })
  app.post('/binary', async (_request, reply) => {
    calls.binary = (calls.binary ?? 0) + 1
    return reply.status(200).header('content-type', 'application/octet-stream').send(Buffer.from([0xff, 0xfe, 0x00, 0x81]))
  })
  app.post('/boom', async () => {
    calls.boom = (calls.boom ?? 0) + 1
    throw new Error('handler exploded')
  })
  app.post('/empty', async (_request, reply) => {
    calls.empty = (calls.empty ?? 0) + 1
    return reply.status(204).send()
  })
  await app.ready()
})

after(async () => {
  await app.close()
})

async function post (path: string, key: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== undefined) headers['idempotency-key'] = key
  return app.inject({ method: 'POST', url: path, headers, payload: JSON.stringify(body) })
}

describe('fastify adapter', () => {
  test('a key extractor reaches the native request and scopes records by principal', async () => {
    const scoped = Fastify()
    scoped.addHook('onRequest', async (request) => {
      const user = request.headers['x-user']
      if (typeof user === 'string') (request as unknown as { user: { id: string } }).user = { id: user }
    })
    await scoped.register(FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }), {
      key: (request) => {
        const key = request.header('idempotency-key')
        const user = (request.raw as { user?: { id: string } }).user?.id
        return key === undefined || user === undefined ? undefined : `${encodeURIComponent(user)}:${key}`
      }
    }) as never)
    let count = 0
    scoped.post('/scoped', async (_request, reply) => {
      count += 1
      return reply.status(201).send({ call: count })
    })
    await scoped.ready()

    const send = async (user?: string) => scoped.inject({
      method: 'POST',
      url: '/scoped',
      headers: { 'idempotency-key': 'shared-key', ...(user === undefined ? {} : { 'x-user': user }) },
      payload: { amount: 10 }
    })

    const alice = await send('alice')
    const aliceRetry = await send('alice')
    assert.deepEqual(alice.json(), { call: 1 })
    assert.deepEqual(aliceRetry.json(), { call: 1 }, 'the same principal replays')
    assert.equal(aliceRetry.headers['idempotency-replayed'], 'true')

    const bob = await send('bob')
    assert.deepEqual(bob.json(), { call: 2 }, 'another principal with the same header key executes fresh')

    const anonymous = await send()
    assert.deepEqual(anonymous.json(), { call: 3 }, 'no principal means no key: unprotected passthrough')
    await scoped.close()
  })

  test('header lookups are case-insensitive for custom extractors', async () => {
    const cased = Fastify()
    await cased.register(FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }), {
      key: (request) => request.header('Idempotency-Key')
    }) as never)
    let count = 0
    cased.post('/cased', async (_request, reply) => {
      count += 1
      return reply.status(201).send({ call: count })
    })
    await cased.ready()

    const send = async () => cased.inject({
      method: 'POST',
      url: '/cased',
      headers: { 'idempotency-key': 'cased-key' },
      payload: { amount: 10 }
    })
    await send()
    const replayed = await send()
    assert.deepEqual(replayed.json(), { call: 1 }, 'the mixed-case lookup found the key, so the retry replays')
    assert.equal(replayed.headers['idempotency-replayed'], 'true')
    await cased.close()
  })

  test('replays status, location and body with the replay marker', async () => {
    const first = await post('/payments', 'fas-1', { amount: 10 })
    assert.equal(first.statusCode, 201)
    assert.equal(first.headers['idempotency-replayed'], undefined)

    const second = await post('/payments', 'fas-1', { amount: 10 })
    assert.equal(second.statusCode, 201)
    assert.equal(second.headers.location, '/payments/9')
    assert.equal(second.headers['idempotency-replayed'], 'true')
    assert.deepEqual(second.json(), { id: 9, amount: 10 })
    assert.equal(calls.payments, 1)
  })

  test('the same key with a different body responds 422', async () => {
    await post('/payments', 'fas-2', { amount: 10 })
    const conflict = await post('/payments', 'fas-2', { amount: 99 })
    assert.equal(conflict.statusCode, 422)
    assert.match(conflict.body, /IDEMPOTENCY_KEY_REUSE/)
  })

  test('requests without a key pass through unprotected', async () => {
    const startingCalls = calls.payments ?? 0
    await post('/payments', undefined, { amount: 1 })
    await post('/payments', undefined, { amount: 1 })
    assert.equal(calls.payments, startingCalls + 2)
  })

  test('binary responses are served intact and never cached', async () => {
    const first = await post('/binary', 'fas-bin', {})
    const second = await post('/binary', 'fas-bin', {})
    assert.deepEqual(new Uint8Array(first.rawPayload), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.deepEqual(new Uint8Array(second.rawPayload), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.equal(calls.binary, 2)
  })

  test('handler errors become 5xx responses and retries re-execute', async () => {
    const first = await post('/boom', 'fas-boom', {})
    assert.equal(first.statusCode, 500)
    const second = await post('/boom', 'fas-boom', {})
    assert.equal(second.statusCode, 500)
    assert.equal(calls.boom, 2)
  })

  test('bodyless responses replay as empty bodies', async () => {
    const first = await post('/empty', 'fas-204', {})
    assert.equal(first.statusCode, 204)
    const second = await post('/empty', 'fas-204', {})
    assert.equal(second.statusCode, 204)
    assert.equal(second.headers['idempotency-replayed'], 'true')
    assert.equal(calls.empty, 1)
  })

  test('the query string stays out of the fingerprint path', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/payments?attempt=1',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'fas-query' },
      payload: JSON.stringify({ amount: 5 })
    })
    assert.equal(first.statusCode, 201)
    const second = await app.inject({
      method: 'POST',
      url: '/payments?attempt=2',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'fas-query' },
      payload: JSON.stringify({ amount: 5 })
    })
    assert.equal(second.headers['idempotency-replayed'], 'true')
  })

  test('body-and-path fingerprinting strips the query string', async () => {
    const queryApp = Fastify()
    await queryApp.register(FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }), { fingerprint: 'body-and-path' }) as never)
    queryApp.post('/', async () => ({ ok: true }))
    await queryApp.ready()

    const inject = async (query: string) => queryApp.inject({
      method: 'POST',
      url: `/${query}`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'fas-bp' },
      payload: JSON.stringify({ a: 1 })
    })
    const first = await inject('?attempt=1')
    assert.equal(first.statusCode, 200)
    const second = await inject('?attempt=2')
    assert.equal(second.statusCode, 200, 'a query-dependent fingerprint would answer 422 here')
    assert.equal(second.headers['idempotency-replayed'], 'true')
    await queryApp.close()
  })

  test('body-and-path fingerprinting distinguishes paths and ignores only the query', async () => {
    const pathApp = Fastify()
    await pathApp.register(FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }), { fingerprint: 'body-and-path' }) as never)
    pathApp.post('/left', async () => ({ ok: true }))
    pathApp.post('/right', async () => ({ ok: true }))
    await pathApp.ready()

    const inject = async (url: string, key: string) => pathApp.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      payload: JSON.stringify({ a: 1 })
    })

    // the same key and body on another path is a key reuse
    await inject('/left', 'fas-paths')
    const otherPath = await inject('/right', 'fas-paths')
    assert.equal(otherPath.statusCode, 422)

    // with and without a query string is the same path
    await inject('/left?attempt=1', 'fas-noq')
    const noQuery = await inject('/left', 'fas-noq')
    assert.equal(noQuery.statusCode, 200, 'stripping the query must not disturb the path itself')
    assert.equal(noQuery.headers['idempotency-replayed'], 'true')
    await pathApp.close()
  })

  test('the fake-hook harness covers bodyless, binary and object payloads plus commit ordering', async () => {
    const memory = new MemoryStorage()
    let completedBeforeSendReturned = false
    const slow: typeof memory = memory
    const storage = {
      acquire: (record: Parameters<MemoryStorage['acquire']>[0], ttl: number) => slow.acquire(record, ttl),
      complete: async (key: string, token: string, outcome: Parameters<MemoryStorage['complete']>[2], ttl: number) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await slow.complete(key, token, outcome, ttl)
        completedBeforeSendReturned = true
      },
      release: (key: string, token: string) => slow.release(key, token),
      extend: (key: string, token: string, ttl: number) => slow.extend(key, token, ttl),
      get: (key: string) => slow.get(key),
      delete: (key: string) => slow.delete(key)
    }
    const hooks: Record<string, (...args: never[]) => Promise<unknown>> = {}
    const fakeInstance = {
      addHook (name: string, hook: (...args: never[]) => Promise<unknown>) { hooks[name] = hook }
    }
    await FastifyPlugin(new Idempotency({ storage }))(fakeInstance as never)

    const roundTrip = async (key: string, payload: unknown) => {
      const request = { method: 'POST', url: '/fake', headers: { 'idempotency-key': key }, body: undefined }
      const headersSet: Record<string, string> = {}
      const reply = {
        statusCode: 200,
        sent: undefined as unknown,
        raw: { on () {} },
        getHeader: (name: string) => headersSet[name],
        header (name: string, value: string) { headersSet[name] = value },
        code (status: number) { reply.statusCode = status; return reply },
        send (body: unknown) { reply.sent = body; return reply }
      }
      await hooks.preHandler?.(request as never, reply as never)
      if (reply.sent === undefined) await hooks.onSend?.(request as never, reply as never, payload as never)
      return { reply, headersSet }
    }

    // undefined payload captures as an empty body and replays as one
    await roundTrip('fk-empty', undefined)
    assert.equal(completedBeforeSendReturned, true, 'the record commits before onSend returns')
    const emptyReplay = await roundTrip('fk-empty', 'would-be-fresh')
    assert.equal(emptyReplay.reply.sent, '')
    assert.equal(emptyReplay.headersSet['idempotency-replayed'], 'true')

    // binary payloads go through the UTF-8 gate
    await roundTrip('fk-buf', Buffer.from('binary-ok'))
    const bufReplay = await roundTrip('fk-buf', 'other')
    assert.equal(bufReplay.reply.sent, 'binary-ok')

    // exotic payload shapes (streams, objects) are served but never cached
    await roundTrip('fk-obj', { not: 'a payload string' })
    const objAgain = await roundTrip('fk-obj', { not: 'a payload string' })
    assert.equal(objAgain.headersSet['idempotency-replayed'], undefined, 'uncacheable payloads never replay')

    // a null payload captures as an empty body, exactly like undefined
    await roundTrip('fk-null', null)
    const nullReplay = await roundTrip('fk-null', 'would-be-fresh')
    assert.equal(nullReplay.reply.sent, '')
    assert.equal(nullReplay.headersSet['idempotency-replayed'], 'true')
  })

  function hookHarness (idempotency: Idempotency) {
    const hooks: Record<string, (...args: never[]) => Promise<unknown>> = {}
    const instance = {
      addHook (name: string, hook: (...args: never[]) => Promise<unknown>) { hooks[name] = hook }
    }
    const replyFor = (writableEnded: boolean) => {
      const closeListeners: Array<() => void> = []
      const reply = {
        statusCode: 200,
        sent: undefined as unknown,
        closeListeners,
        // Only the close event is a lifecycle backstop; anything else the
        // adapter listened for would leave the record locked.
        raw: {
          writableEnded,
          on (event: string, listener: () => void) { if (event === 'close') closeListeners.push(listener) }
        },
        getHeader: () => undefined,
        header () {},
        code (status: number) { reply.statusCode = status; return reply },
        send (body: unknown) { reply.sent = body; return reply }
      }
      return reply
    }
    return { hooks, instance, replyFor }
  }

  test('a finished response that never reached onSend releases the key on close', async () => {
    // reply.hijack() answers the client directly and skips onSend; without
    // the raw close backstop the record would stay locked until its TTL
    // expired and every retry would answer 409.
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const { hooks, instance, replyFor } = hookHarness(idempotency)
    await FastifyPlugin(idempotency)(instance as never)

    const hijacked = replyFor(true)
    const request = { method: 'POST', url: '/fake', headers: { 'idempotency-key': 'hijack-1' }, body: undefined }
    await hooks.preHandler?.(request as never, hijacked as never)
    assert.equal(hijacked.closeListeners.length, 1, 'the adapter listens for the raw close event')

    // The hijacked response ended; the connection closes without onSend.
    for (const listener of hijacked.closeListeners) listener()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await idempotency.get('hijack-1'), null, 'the lock is released, not held until it expires')

    // The next attempt on the same key acquires it instead of getting a 409.
    const reply = replyFor(false)
    await hooks.preHandler?.(request as never, reply as never)
    await hooks.onSend?.(request as never, reply as never, 'fresh' as never)
    assert.equal(reply.sent, undefined, 'no conflict response was sent')
  })

  test('a connection that dies mid-handler keeps the lock, so no retry runs twice', async () => {
    // Node does not cancel a handler when the client goes away: the work is
    // still running, so releasing the record here would let the very next
    // retry execute it a second time under one idempotency key.
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const { hooks, instance, replyFor } = hookHarness(idempotency)
    await FastifyPlugin(idempotency)(instance as never)

    const aborted = replyFor(false)
    const request = { method: 'POST', url: '/fake', headers: { 'idempotency-key': 'abort-1' }, body: undefined }
    await hooks.preHandler?.(request as never, aborted as never)

    // The client hangs up before the response was finished.
    for (const listener of aborted.closeListeners) listener()
    await new Promise((resolve) => setImmediate(resolve))
    const held = await idempotency.get('abort-1')
    assert.equal(held?.status, 'in-progress', 'the key stays locked while the handler runs on')

    // A retry arriving now is refused instead of executing the work again.
    const retry = replyFor(false)
    await hooks.preHandler?.(request as never, retry as never)
    assert.equal(retry.statusCode, 409, 'the retry is told the first attempt is still in flight')

    // The original handler finishes late: its outcome is what gets stored.
    aborted.statusCode = 201
    await hooks.onSend?.(request as never, aborted as never, 'charged once' as never)
    const stored = await idempotency.get('abort-1')
    assert.equal(stored?.status, 'completed')

    // From here the key replays, exactly as if the client had never dropped.
    const replayed = replyFor(false)
    await hooks.preHandler?.(request as never, replayed as never)
    assert.equal(replayed.sent, 'charged once')
    assert.equal(replayed.statusCode, 201)
  })

  test('a non-string, non-array header value runs unprotected', async () => {
    const hooks: Record<string, (...args: never[]) => Promise<unknown>> = {}
    const fakeInstance = {
      addHook (name: string, hook: (...args: never[]) => Promise<unknown>) { hooks[name] = hook }
    }
    await FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }))(fakeInstance as never)

    const roundTrip = async () => {
      const request = { method: 'POST', url: '/fake', headers: { 'idempotency-key': 42 }, body: undefined }
      const headersSet: Record<string, string> = {}
      const reply = {
        statusCode: 200,
        sent: undefined as unknown,
        raw: { on () {} },
        getHeader: (name: string) => headersSet[name],
        header (name: string, value: string) { headersSet[name] = value },
        code (status: number) { reply.statusCode = status; return reply },
        send (body: unknown) { reply.sent = body; return reply }
      }
      await hooks.preHandler?.(request as never, reply as never)
      if (reply.sent === undefined) await hooks.onSend?.(request as never, reply as never, 'fresh' as never)
      return reply
    }
    const first = await roundTrip()
    const second = await roundTrip()
    assert.equal(first.sent, undefined, 'a malformed header value must not become a key')
    assert.equal(second.sent, undefined)
  })

  test('a replayed persisted failure surfaces through the error handler', async () => {
    const storage = new MemoryStorage()
    await storage.acquire({ key: 'poisoned', token: 't', storedAt: Date.now() }, 60_000)
    await storage.complete('poisoned', 't', {
      status: 'failed',
      error: JSON.stringify({ name: 'PaymentDeclinedError', message: 'card declined' })
    }, 60_000)
    const poisonedApp = Fastify()
    await poisonedApp.register(FastifyPlugin(new Idempotency({ storage, persistFailures: true })) as never)
    poisonedApp.post('/pay', async () => ({ never: true }))
    await poisonedApp.ready()

    const response = await poisonedApp.inject({
      method: 'POST',
      url: '/pay',
      headers: { 'idempotency-key': 'poisoned' }
    })
    assert.equal(response.statusCode, 500)
    await poisonedApp.close()
  })

  test('takes the first value of an array header', async () => {
    // Real HTTP joins duplicate headers into one string before the plugin
    // sees them, so the array branch is exercised by driving the hooks
    // directly with a raw multi-value header.
    const hooks: Record<string, (...args: never[]) => Promise<unknown>> = {}
    const fakeInstance = {
      addHook (name: string, hook: (...args: never[]) => Promise<unknown>) {
        hooks[name] = hook
      }
    }
    await FastifyPlugin(new Idempotency({ storage: new MemoryStorage() }))(fakeInstance as never)

    const roundTrip = async (payload: string) => {
      const request = {
        method: 'POST',
        url: '/fake?x=1',
        headers: { 'idempotency-key': ['array-key', 'ignored'] },
        body: { n: 1 }
      }
      const headersSet: Record<string, string> = {}
      const reply = {
        statusCode: 201,
        sent: undefined as unknown,
        raw: { on () {} },
        getHeader: (name: string) => headersSet[name],
        header (name: string, value: string) { headersSet[name] = value },
        code (status: number) { reply.statusCode = status; return reply },
        send (body: unknown) { reply.sent = body; return reply }
      }
      await hooks.preHandler?.(request as never, reply as never)
      if (reply.sent === undefined) {
        await hooks.onSend?.(request as never, reply as never, payload as never)
        return { reply, body: payload }
      }
      return { reply, body: reply.sent }
    }

    const first = await roundTrip('first-response')
    assert.equal(first.body, 'first-response')
    const second = await roundTrip('second-response')
    assert.equal(second.body, 'first-response')
    assert.equal(second.reply.getHeader('idempotency-replayed'), 'true')
  })
})
