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
