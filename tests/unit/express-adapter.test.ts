import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

import express from 'express'

import { ExpressMiddleware } from '../../src/express/index'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

let server: Server
let base: string
let calls: Record<string, number>

before(async () => {
  calls = {}
  const idempotency = new Idempotency({ storage: new MemoryStorage() })
  const app = express()
  app.use(express.json())
  app.use(ExpressMiddleware(idempotency, { enforce: false, maxBodyBytes: 1_024 }) as never)

  app.post('/payments', (req, res) => {
    calls.payments = (calls.payments ?? 0) + 1
    res.status(201).location('/payments/1').json({ id: 1, amount: (req.body as { amount: number }).amount })
  })
  app.post('/binary', (_req, res) => {
    calls.binary = (calls.binary ?? 0) + 1
    res.status(200).type('application/octet-stream').send(Buffer.from([0xff, 0xfe, 0x00, 0x81]))
  })
  app.post('/huge', (_req, res) => {
    calls.huge = (calls.huge ?? 0) + 1
    res.status(200).send('x'.repeat(4_096))
  })
  app.post('/boom', (_req, _res) => {
    calls.boom = (calls.boom ?? 0) + 1
    throw new Error('handler exploded')
  })

  // Expected handler errors answer 500 without reaching Express's default
  // error handler, which would dump the stack to stderr and drown out any
  // real failure in the test output.
  const silentErrors: express.ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: 'handler exploded' })
  }
  app.use(silentErrors)

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function post (path: string, key: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== undefined) headers['idempotency-key'] = key
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('express adapter', () => {
  test('replays status, location and body with the replay marker', async () => {
    const first = await post('/payments', 'exp-1', { amount: 10 })
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('idempotency-replayed'), null)

    const second = await post('/payments', 'exp-1', { amount: 10 })
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('location'), '/payments/1')
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await second.json(), { id: 1, amount: 10 })
    assert.equal(calls.payments, 1)
  })

  test('the same key with a different body responds 422', async () => {
    await post('/payments', 'exp-2', { amount: 10 })
    const conflict = await post('/payments', 'exp-2', { amount: 99 })
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
    const first = await post('/binary', 'exp-bin', {})
    const second = await post('/binary', 'exp-bin', {})
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.equal(calls.binary, 2)
  })

  test('responses over maxBodyBytes are served and never cached', async () => {
    const first = await post('/huge', 'exp-huge', {})
    const second = await post('/huge', 'exp-huge', {})
    assert.equal((await first.text()).length, 4_096)
    assert.equal((await second.text()).length, 4_096)
    assert.equal(calls.huge, 2)
  })

  test('handler errors become 5xx responses and retries re-execute', async () => {
    const first = await post('/boom', 'exp-boom', {})
    assert.equal(first.status, 500)
    const second = await post('/boom', 'exp-boom', {})
    assert.equal(second.status, 500)
    assert.equal(calls.boom, 2)
  })
})
