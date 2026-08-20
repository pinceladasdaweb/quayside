import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { Hono } from 'hono'

import { HonoMiddleware } from '../../src/hono/index'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

// The hono adapter settles the record concurrently with the response
// dispatch, so a follow-up call issued immediately can still find the
// record IN_PROGRESS: wait for it to settle (stored, or released to null)
// before asserting on the second call.
async function settled (instance: Idempotency, key: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await instance.get(key)
    if (record === null || record.status !== 'in-progress') return
    await sleep(5)
  }
  throw new Error(`the record for "${key}" never settled`)
}

let app: Hono
let calls: Record<string, number>
let idempotency: Idempotency

before(() => {
  calls = {}
  idempotency = new Idempotency({ storage: new MemoryStorage() })
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
  app.post('/declared-small', (c) => {
    calls.declaredSmall = (calls.declaredSmall ?? 0) + 1
    return c.body('cached', 200, { 'content-length': '6' })
  })
  app.post('/declared-exact', (c) => {
    calls.declaredExact = (calls.declaredExact ?? 0) + 1
    return c.body('small body, honest header', 200, { 'content-length': '1024' })
  })
  app.post('/stream-exact', (c) => {
    calls.streamExact = (calls.streamExact ?? 0) + 1
    const chunk = new TextEncoder().encode('x'.repeat(1_024))
    const stream = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(chunk)
        controller.close()
      }
    })
    return c.body(stream, 200)
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
    await settled(idempotency, 'hon-1')

    const second = await post('/payments', 'hon-1', { amount: 10 })
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('location'), '/payments/7')
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await second.json(), { id: 7, amount: 10 })
    assert.equal(calls.payments, 1)
  })

  test('the same key with a different body responds 422', async () => {
    await post('/payments', 'hon-2', { amount: 10 })
    await settled(idempotency, 'hon-2')
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
    await settled(idempotency, 'hon-bin')
    const second = await post('/binary', 'hon-bin', {})
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([0xff, 0xfe, 0x00, 0x81]))
    assert.equal(calls.binary, 2)
  })

  test('handler errors become 5xx responses and retries re-execute', async () => {
    const first = await post('/boom', 'hon-boom', {})
    assert.equal(first.status, 500)
    await settled(idempotency, 'hon-boom')
    const second = await post('/boom', 'hon-boom', {})
    assert.equal(second.status, 500)
    assert.equal(calls.boom, 2)
  })

  test('bodyless responses replay as empty bodies', async () => {
    const first = await app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-204' } })
    assert.equal(first.status, 204)
    await settled(idempotency, 'hon-204')
    const second = await app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-204' } })
    assert.equal(second.status, 204)
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.empty, 1)
  })

  test('declared content lengths within the cap still cache, including exactly at it', async () => {
    await post('/declared-small', 'hon-small', {})
    await settled(idempotency, 'hon-small')
    const smallReplay = await post('/declared-small', 'hon-small', {})
    assert.equal(await smallReplay.text(), 'cached')
    assert.equal(smallReplay.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.declaredSmall, 1)

    await post('/declared-exact', 'hon-dexact', {})
    await settled(idempotency, 'hon-dexact')
    const exactReplay = await post('/declared-exact', 'hon-dexact', {})
    assert.equal(exactReplay.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.declaredExact, 1)
  })

  test('a streamed body of exactly the cap is cached', async () => {
    await post('/stream-exact', 'hon-sexact', {})
    await settled(idempotency, 'hon-sexact')
    const replay = await post('/stream-exact', 'hon-sexact', {})
    assert.equal((await replay.text()).length, 1_024)
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.streamExact, 1)
  })

  test('an empty hono body and a keyless core call share the fingerprint semantics', async () => {
    // The adapter must fingerprint a bodyless request as absent, staying
    // interchangeable with non-HTTP callers of the same key.
    const first = await app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-cross' } })
    assert.equal(first.status, 204)
    await settled(idempotency, 'hon-cross')
    const direct = await idempotency.executeWithMetadata({ key: 'hon-cross' }, async () => 'never')
    assert.equal(direct.replayed, true)
  })

  test('a streamed body over the cap is served and never cached', async () => {
    const first = await post('/stream-huge', 'hon-stream', {})
    await settled(idempotency, 'hon-stream')
    const second = await post('/stream-huge', 'hon-stream', {})
    assert.equal((await first.text()).length, 1_400)
    assert.equal((await second.text()).length, 1_400)
    assert.equal(calls.streamHuge, 2)
  })

  test('a declared content-length over the cap is served and never cached', async () => {
    const first = await post('/declared-huge', 'hon-declared', {})
    await settled(idempotency, 'hon-declared')
    const second = await post('/declared-huge', 'hon-declared', {})
    assert.equal(await first.text(), 'tiny body')
    assert.equal(await second.text(), 'tiny body')
    assert.equal(calls.declaredHuge, 2)
  })

  test('methods outside the configured set pass through', async () => {
    const response = await app.request('/empty', { method: 'GET' })
    assert.equal(response.status, 404)
  })

  test('the request body is read only when the kernel will fingerprint it', async () => {
    // Reading clones and buffers the whole request: an unprotected method or
    // a keyless request must not pay for a body nobody looks at.
    const middleware = HonoMiddleware(new Idempotency({ storage: new MemoryStorage() }), { maxBodyBytes: 1_024 })
    let clones = 0
    const contextFor = (method: string, key?: string) => {
      const headers: Record<string, string | undefined> = { 'idempotency-key': key }
      return {
        req: {
          method,
          path: '/fake',
          header: (name: string) => headers[name],
          raw: {
            clone () {
              clones += 1
              return { text: async () => '{"amount":1}' }
            }
          } as unknown as Request
        },
        res: new Response('ok', { status: 200 })
      }
    }
    const next = async () => {}

    await middleware(contextFor('GET'), next)
    assert.equal(clones, 0, 'an unprotected method never reads the body')
    await middleware(contextFor('GET', 'hon-gate-get'), next)
    assert.equal(clones, 0, 'a key on an unprotected method changes nothing')
    await middleware(contextFor('POST'), next)
    assert.equal(clones, 0, 'a request without a key never reads the body')
    await middleware(contextFor('POST', ''), next)
    assert.equal(clones, 0, 'an empty key is no key at all')
    await middleware(contextFor('POST', 'hon-gate'), next)
    assert.equal(clones, 1, 'a protected, keyed request is fingerprinted')
  })

  test('a streaming response reaches the client before the stream ends', async () => {
    // The regression this adapter shipped with: the capture drained the
    // whole clone before the middleware returned, so a streaming response
    // (SSE, chunked) reached the client only after the source ended or hit
    // the size cap, with the lock held throughout. The middleware must
    // return as soon as downstream produced its response.
    const instance = new Idempotency({ storage: new MemoryStorage() })
    const middleware = HonoMiddleware(instance, {})
    let releaseStream: () => void = () => {}
    const streamOpen = new Promise<void>((resolve) => { releaseStream = resolve })
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(encoder.encode('first '))
        streamOpen.then(() => {
          controller.enqueue(encoder.encode('rest'))
          controller.close()
        }).catch(() => {})
      }
    })
    const requestFacts = (key: string) => ({
      method: 'POST',
      path: '/sse',
      header: (name: string) => (name === 'idempotency-key' ? key : undefined),
      raw: { clone () { return { text: async () => '' } } } as unknown as Request
    })
    const context = { req: requestFacts('hon-sse'), res: new Response('unset') }

    // Awaiting the middleware WITHOUT releasing the stream is the test:
    // before the fix this await only resolved once the stream closed.
    const returned = await middleware(context as never, async () => {
      context.res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    assert.equal(returned, undefined, 'the middleware returned while the stream was still open')

    // Once the stream ends, the concurrent capture settles the record and
    // a retry replays the full streamed body.
    releaseStream()
    await settled(instance, 'hon-sse')
    const replay = await middleware(
      { req: requestFacts('hon-sse'), res: new Response('unset') } as never,
      async () => { throw new Error('a replay never runs the handler') }
    )
    assert.equal(replay?.headers.get('idempotency-replayed'), 'true')
    assert.equal(await replay?.text(), 'first rest', 'the replay carries the whole streamed body')
  })

  test('the key extractor never runs for unprotected methods', async () => {
    // handle() checks the method before deriving the key; the buffering
    // pre-gate has to do the same, or a GET on a public route crashes an
    // extractor that assumes protected-route context, only on hono.
    let extractions = 0
    const middleware = HonoMiddleware(new Idempotency({ storage: new MemoryStorage() }), {
      key: (request) => {
        extractions += 1
        return request.header('idempotency-key')
      }
    })
    let ran = 0
    const context = {
      req: { method: 'GET', path: '/public', header: () => undefined, raw: {} as Request },
      res: new Response('ok')
    }
    await middleware(context as never, async () => { ran += 1 })
    assert.equal(extractions, 0, 'an unprotected method never pays for, nor can it crash, the extractor')
    assert.equal(ran, 1, 'and passes through')
  })

  test('a key extractor scopes records by principal and still gates the body read', async () => {
    // raw is the Hono context, so the extractor reads what auth middleware
    // stored on it; an extractor that yields no key must also keep the
    // body-buffering gate closed.
    const scopedInstance = new Idempotency({ storage: new MemoryStorage() })
    const middleware = HonoMiddleware(scopedInstance, {
      key: (request) => {
        const key = request.header('idempotency-key')
        const user = (request.raw as { get (name: string): string | undefined }).get('user')
        return key === undefined || user === undefined ? undefined : `${encodeURIComponent(user)}:${key}`
      }
    })
    let clones = 0
    let runs = 0
    const contextFor = (user?: string) => ({
      get: (name: string) => (name === 'user' ? user : undefined),
      req: {
        method: 'POST',
        path: '/fake',
        header: (name: string) => (name === 'idempotency-key' ? 'hon-scope' : undefined),
        raw: {
          clone () {
            clones += 1
            return { text: async () => '{"amount":1}' }
          }
        } as unknown as Request
      },
      res: new Response('ok', { status: 200 })
    })
    const next = async () => { runs += 1 }

    await middleware(contextFor(), next)
    assert.equal(clones, 0, 'an extractor yielding no key means the body is never read')
    assert.equal(runs, 1, 'and the chain runs unprotected')

    await middleware(contextFor('alice'), next)
    await settled(scopedInstance, 'alice:hon-scope')
    const replay = await middleware(contextFor('alice'), next)
    assert.equal(replay?.headers.get('idempotency-replayed'), 'true', 'the same principal replays')
    await middleware(contextFor('bob'), next)
    assert.equal(runs, 3, 'bob executes fresh under the same header key')
  })

  test('enforce answers 400 without ever reading the body', async () => {
    const middleware = HonoMiddleware(new Idempotency({ storage: new MemoryStorage() }), { enforce: true })
    let clones = 0
    const context = {
      req: {
        method: 'POST',
        path: '/fake',
        header: () => undefined,
        raw: {
          clone () {
            clones += 1
            return { text: async () => '{"amount":1}' }
          }
        } as unknown as Request
      },
      res: new Response('ok', { status: 200 })
    }
    const response = await middleware(context, async () => {})
    assert.equal(response?.status, 400)
    assert.equal(clones, 0, 'the 400 needs no fingerprint, so the body is never buffered')
  })

  test('enforce reads nothing and still answers 400 without a key', async () => {
    const strict = new Hono()
    strict.use(HonoMiddleware(new Idempotency({ storage: new MemoryStorage() }), { enforce: true }) as never)
    strict.post('/payments', (c) => c.json({ ok: true }, 201))
    const response = await strict.request('/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1 })
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /IDEMPOTENCY_KEY_REQUIRED/)
  })

  test('a request without a body runs unfingerprinted and replays', async () => {
    const startingCalls = calls.empty ?? 0
    const request = async () => app.request('/empty', { method: 'POST', headers: { 'idempotency-key': 'hon-nobody' } })
    await request()
    const second = await request()
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.empty, startingCalls + 1)
  })
})
