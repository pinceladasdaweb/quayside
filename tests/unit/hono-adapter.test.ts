import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { Hono } from 'hono'

import { HonoMiddleware } from '../../src/hono/index'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

let app: Hono
let calls: Record<string, number>

before(() => {
  calls = {}
  const idempotency = new Idempotency({ storage: new MemoryStorage() })
  app = new Hono()
  app.use(HonoMiddleware(idempotency, { maxBodyBytes: 1_024 }) as never)

  app.post('/payments', async (c) => {
    calls.payments = (calls.payments ?? 0) + 1
    const body = await c.req.json<{ amount: number }>()
    c.header('location', '/payments/7')
    return c.json({ id: 7, amount: body.amount }, 201)
  })
  app.post('/binary', (c) => {
    calls.binary = (calls.binary ?? 0) + 1
    return c.body(new Uint8Array([0xff, 0xfe, 0x00, 0x81]).buffer as ArrayBuffer, 200, {
      'content-type': 'application/octet-stream'
    })
  })
  app.post('/boom', () => {
    calls.boom = (calls.boom ?? 0) + 1
    throw new Error('handler exploded')
  })
})

async function post (path: string, key: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== undefined) headers['idempotency-key'] = key
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('hono adapter', () => {
  test('replays status, location and body with the replay marker', async () => {
    const first = await post('/payments', 'hon-1', { amount: 10 })
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('idempotency-replayed'), null)

    const second = await post('/payments', 'hon-1', { amount: 10 })
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('location'), '/payments/7')
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await second.json(), { id: 7, amount: 10 })
    assert.equal(calls.payments, 1)
  })

  test('the same key with a different body responds 422', async () => {
    await post('/payments', 'hon-2', { amount: 10 })
    const conflict = await post('/payments', 'hon-2', { amount: 99 })
    assert.equal(conflict.status, 422)
    assert.match(await conflict.text(), /IDEMPOTENCY_KEY_REUSE/)
  })

  test('requests without a key pass through unprotected', async () => {
    const startingCalls = calls.payments ?? 0
    await post('/payments', undefined, { amount: 1 })
    await post('/payments', undefined, { amount: 1 })
    assert.equal(calls.payments, startingCalls + 2)
  })

  test('binary responses are served intact and never cached', async () => {
    const first = await post('/binary', 'hon-bin', {})
    const second = await post('/binary', 'hon-bin', {})
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.equal(calls.binary, 2)
  })

  test('handler errors become 5xx responses and retries re-execute', async () => {
    const first = await post('/boom', 'hon-boom', {})
    assert.equal(first.status, 500)
    const second = await post('/boom', 'hon-boom', {})
    assert.equal(second.status, 500)
    assert.equal(calls.boom, 2)
  })
})
