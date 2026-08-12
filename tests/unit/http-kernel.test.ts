import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { HttpIdempotencyKernel } from '../../src/http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions, HttpRequestFacts } from '../../src/http/kernel'
import { Idempotency } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'

function kernelWith (options: HttpKernelOptions = {}, idempotencyOverrides = {}) {
  const idempotency = new Idempotency({ storage: new MemoryStorage(), ...idempotencyOverrides })
  return new HttpIdempotencyKernel(idempotency, options)
}

function post (over: Partial<HttpRequestFacts> & { key?: string } = {}): HttpRequestFacts {
  const headers: Record<string, string | undefined> = { 'idempotency-key': over.key ?? 'k-1' }
  return {
    method: over.method ?? 'POST',
    path: over.path ?? '/payments',
    body: 'body' in over ? over.body : { amount: 10 },
    header: (name) => headers[name]
  }
}

function ok (body = '{"id":1}', status = 201): CapturedHttpResponse {
  return { status, headers: { 'content-type': 'application/json', location: '/payments/1' }, body }
}

describe('http kernel routing', () => {
  test('methods outside the configured set pass through', async () => {
    const kernel = kernelWith()
    const outcome = await kernel.handle(post({ method: 'GET' }), async () => ok())
    assert.deepEqual(outcome, { kind: 'passthrough' })
  })

  test('a missing key passes through by default and rejects with 400 when enforced', async () => {
    const relaxed = kernelWith()
    const request = { ...post(), header: () => undefined }
    assert.deepEqual(await relaxed.handle(request, async () => ok()), { kind: 'passthrough' })

    const strict = kernelWith({ enforce: true })
    const outcome = await strict.handle(request, async () => ok())
    assert.equal(outcome.kind, 'respond')
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 400)
  })
})

describe('http kernel replay', () => {
  test('first execution is handled downstream, replay serves status, headers, body and the marker', async () => {
    const kernel = kernelWith()
    let calls = 0
    const run = async () => { calls += 1; return ok() }

    const first = await kernel.handle(post(), run)
    assert.deepEqual(first, { kind: 'handled' })

    const second = await kernel.handle(post(), run)
    assert.equal(calls, 1)
    assert.equal(second.kind, 'respond')
    if (second.kind === 'respond') {
      assert.equal(second.response.status, 201)
      assert.equal(second.response.headers.location, '/payments/1')
      assert.equal(second.response.headers['idempotency-replayed'], 'true')
      assert.equal(second.response.body, '{"id":1}')
    }
  })

  test('the same key with a different body responds 422', async () => {
    const kernel = kernelWith()
    await kernel.handle(post({ body: { amount: 10 } }), async () => ok())
    const outcome = await kernel.handle(post({ body: { amount: 99 } }), async () => ok())
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 422)
  })

  test('body-and-path fingerprinting distinguishes the same body on another path', async () => {
    const kernel = kernelWith({ fingerprint: 'body-and-path' })
    await kernel.handle(post({ path: '/a' }), async () => ok())
    const outcome = await kernel.handle(post({ path: '/b' }), async () => ok())
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 422)
  })

  test('a custom fingerprint function receives the request facts', async () => {
    const kernel = kernelWith({ fingerprint: (request) => request.header('x-tenant') })
    const headers: Record<string, string> = { 'idempotency-key': 'k-1', 'x-tenant': 't1' }
    const request: HttpRequestFacts = { method: 'POST', path: '/p', body: {}, header: (n) => headers[n] }
    await kernel.handle(request, async () => ok())
    headers['x-tenant'] = 't2'
    const outcome = await kernel.handle(request, async () => ok())
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 422)
  })
})

describe('http kernel conflicts and failures', () => {
  test('concurrent execution responds 409 with Retry-After', async () => {
    const kernel = kernelWith({ retryAfterSeconds: 7 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = kernel.handle(post(), async () => { await gate; return ok() })
    await new Promise((resolve) => setImmediate(resolve))

    const outcome = await kernel.handle(post(), async () => ok())
    assert.equal(outcome.kind, 'respond')
    if (outcome.kind === 'respond') {
      assert.equal(outcome.response.status, 409)
      assert.equal(outcome.response.headers['retry-after'], '7')
      assert.match(outcome.response.body, /IDEMPOTENCY_IN_PROGRESS/)
    }
    release()
    await running
  })

  test('storage unavailability responds 503', async () => {
    const idempotency = new Idempotency({
      storage: {
        acquire: async () => { throw new Error('down') },
        complete: async () => {},
        release: async () => {},
        extend: async () => {},
        get: async () => null,
        delete: async () => {}
      }
    })
    const kernel = new HttpIdempotencyKernel(idempotency)
    const outcome = await kernel.handle(post(), async () => ok())
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 503)
  })

  test('application errors from downstream are rethrown for the framework to handle', async () => {
    const kernel = kernelWith()
    await assert.rejects(
      kernel.handle(post(), async () => { throw new Error('handler blew up') }),
      /handler blew up/
    )
  })
})

describe('http kernel cacheability', () => {
  test('5xx responses are served but never cached', async () => {
    const kernel = kernelWith()
    let calls = 0
    const run = async () => { calls += 1; return ok('oops', calls === 1 ? 502 : 200) }
    assert.deepEqual(await kernel.handle(post(), run), { kind: 'handled' })
    assert.deepEqual(await kernel.handle(post(), run), { kind: 'handled' })
    assert.equal(calls, 2)
  })

  test('oversized bodies are served but never cached', async () => {
    const kernel = kernelWith({ maxBodyBytes: 8 })
    assert.equal(kernel.cacheableBody('within'), 'within')
    assert.equal(kernel.cacheableBody('way beyond the cap'), null)

    let calls = 0
    const run = async () => {
      calls += 1
      const body = kernel.cacheableBody('way beyond the cap')
      return body === null ? null : ok(body)
    }
    assert.deepEqual(await kernel.handle(post(), run), { kind: 'handled' })
    assert.deepEqual(await kernel.handle(post(), run), { kind: 'handled' })
    assert.equal(calls, 2)
  })

  test('non-UTF-8 bodies are served but never cached', async () => {
    const kernel = kernelWith()
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x81])
    assert.equal(kernel.cacheableBody(binary), null)
    assert.equal(kernel.cacheableBody(Buffer.from('texto', 'utf8')), 'texto')
  })

  test('uncacheable responses release the record even with persistFailures enabled', async () => {
    const kernel = kernelWith({}, { persistFailures: true })
    let calls = 0
    const run = async () => { calls += 1; return null }
    assert.deepEqual(await kernel.handle(post(), run), { kind: 'handled' })
    const second = await kernel.handle(post(), run)
    assert.equal(calls, 2)
    assert.notEqual(second.kind, 'respond')
  })
})
