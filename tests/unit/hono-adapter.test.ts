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
  app.post('/empty', (c) => {
    calls.empty = (calls.empty ?? 0) + 1
    return c.body(null, 204)
  })
  app.post('/stream-huge', (c) => {
    calls.streamHuge = (calls.streamHuge ?? 0) + 1
    // No content-length: the capture only discovers the overflow while
    // reading the stream clone.
    const chunk = new TextEncoder().encode('x'.repeat(700))
    const stream = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      }
    })
    return c.body(stream, 200)
  })
  app.post('/declared-huge', (c) => {
    calls.declaredHuge = (calls.declaredHuge ?? 0) + 1
    // The declared length is what the capture trusts before reading.
    return c.body('tiny body', 200, { 'content-length': '999999' })
  })
  // Expected handler errors answer 500 without reaching Hono's default
  // error handler, which would dump the stack to stderr and drown out any
  // real failure in the test output.
  app.onError((_error, c) => c.json({ error: 'handler exploded' }, 500))
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

  test('bodyless responses replay as empty bodies', async () => {
    const first = await app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-204' } })
    assert.equal(first.status, 204)
    const second = await app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-204' } })
    assert.equal(second.status, 204)
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.empty, 1)
  })

  test('a streamed body over the cap is served and never cached', async () => {
    const first = await post('/stream-huge', 'hon-stream', {})
    const second = await post('/stream-huge', 'hon-stream', {})
    assert.equal((await first.text()).length, 1_400)
    assert.equal((await second.text()).length, 1_400)
    assert.equal(calls.streamHuge, 2)
  })

  test('a declared content-length over the cap is served and never cached', async () => {
    const first = await post('/declared-huge', 'hon-declared', {})
    const second = await post('/declared-huge', 'hon-declared', {})
    assert.equal(await first.text(), 'tiny body')
    assert.equal(await second.text(), 'tiny body')
    assert.equal(calls.declaredHuge, 2)
  })

  test('methods outside the configured set pass through', async () => {
    const response = await app.request('/empty', { method: 'GET' })
    assert.equal(response.status, 404)
  })

  test('a request without a body runs unfingerprinted and replays', async () => {
    const request = async () => app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-nobody' } })
    await request()
    const second = await request()
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.empty, 2)
  })
})
