import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import Fastify, { type FastifyInstance } from 'fastify'

import { FastifyPlugin } from '../../src/fastify/index'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

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
})
