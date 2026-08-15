import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { HttpIdempotencyKernel } from '../../src/http/kernel'
import type { CapturedHttpResponse, HttpKernelOptions, HttpRequestFacts } from '../../src/http/kernel'
import { FencingError, Idempotency } from '../../src/index'
import type { IdempotencyStorage } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { warningsDuring } from '../helpers/warnings'

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
    const problem = JSON.parse(outcome.kind === 'respond' ? outcome.response.body : '{}') as { error: string, detail: string }
    assert.equal(problem.error, 'IDEMPOTENCY_KEY_REQUIRED')
    assert.match(problem.detail, /idempotency-key/, 'the problem names the missing header')
    assert.match(problem.detail, /POST/, 'the problem names the method it applies to')
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

  test('body-and-path fingerprinting distinguishes another body on the same path', async () => {
    const kernel = kernelWith({ fingerprint: 'body-and-path' })
    await kernel.handle(post({ body: { amount: 10 } }), async () => ok())
    const outcome = await kernel.handle(post({ body: { amount: 99 } }), async () => ok())
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
    assert.equal(kernel.decodeUtf8('text'), 'text')
    assert.equal(kernel.decodeUtf8(Buffer.from('text')), 'text')
    assert.equal(kernel.decodeUtf8(binary), null)
  })

  test('the size cap is inclusive: exactly maxBodyBytes still caches', () => {
    const kernel = kernelWith({ maxBodyBytes: 8 })
    assert.equal(kernel.cacheableBody('x'.repeat(8)), 'x'.repeat(8))
    assert.equal(kernel.cacheableBody('x'.repeat(9)), null)
    assert.equal(kernel.cacheableBody(Buffer.alloc(8, 120)), 'x'.repeat(8))
    assert.equal(kernel.cacheableBody(Buffer.alloc(9, 120)), null)
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

  test('an uncacheable response leaves no record for a waiter to replay', async () => {
    // The sentinel is control flow, never state: nothing is stored even with
    // persistFailures on, so no concurrent waiter can ever observe it and
    // run unprotected, and no failed record survives to poison the key.
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, persistFailures: true, onConflict: 'wait' })
    const kernel = new HttpIdempotencyKernel(idempotency)

    assert.deepEqual(await kernel.handle(post({ key: 'k-1' }), async () => ok('{}', 500)), { kind: 'handled' })
    assert.equal(await idempotency.get('k-1'), null, 'the uncacheable run stored nothing')

    // The key is still fully protected on the next attempt.
    let calls = 0
    const run = async () => { calls += 1; return ok() }
    assert.deepEqual(await kernel.handle(post({ key: 'k-1' }), run), { kind: 'handled' })
    const replay = await kernel.handle(post({ key: 'k-1' }), run)
    assert.equal(calls, 1)
    assert.equal(replay.kind, 'respond')
  })

  test('a waiter blocked on an uncacheable run takes the key over instead of passing through', async () => {
    const idempotency = new Idempotency({
      storage: new MemoryStorage(),
      persistFailures: true,
      onConflict: 'wait'
    })
    const kernel = new HttpIdempotencyKernel(idempotency)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })

    const uncacheable = kernel.handle(post({ key: 'k-2' }), async () => { await gate; return null })
    await new Promise((resolve) => setImmediate(resolve))
    let waiterRan = 0
    const waiter = kernel.handle(post({ key: 'k-2' }), async () => { waiterRan += 1; return ok() })
    release()

    assert.deepEqual(await uncacheable, { kind: 'handled' })
    // The waiter runs the handler through the kernel, under its own lock,
    // rather than being waved past the protection entirely.
    assert.deepEqual(await waiter, { kind: 'handled' })
    assert.equal(waiterRan, 1)
  })

  test('a request without a body fingerprints nothing and still replays', async () => {
    const kernel = kernelWith()
    let calls = 0
    const run = async () => { calls += 1; return ok() }
    await kernel.handle(post({ body: undefined }), run)
    const second = await kernel.handle(post({ body: undefined }), run)
    assert.equal(calls, 1)
    assert.equal(second.kind, 'respond')
  })
})

describe('http kernel configuration', () => {
  test('PATCH is protected by default', async () => {
    const kernel = kernelWith()
    let calls = 0
    const run = async () => { calls += 1; return ok() }
    assert.deepEqual(await kernel.handle(post({ method: 'PATCH' }), run), { kind: 'handled' })
    const replay = await kernel.handle(post({ method: 'PATCH' }), run)
    assert.equal(calls, 1)
    assert.equal(replay.kind, 'respond')
  })

  test('an empty-string key behaves like a missing key', async () => {
    const relaxed = kernelWith()
    const request = { ...post(), header: () => '' }
    assert.deepEqual(await relaxed.handle(request, async () => ok()), { kind: 'passthrough' })
    const strict = kernelWith({ enforce: true })
    const outcome = await strict.handle(request, async () => ok())
    assert.equal(outcome.kind === 'respond' && outcome.response.status, 400)
  })

  test('a settlement failure after the response was sent is reported, never answered', async () => {
    // The handler already responded: replacing its 2xx with a 5xx would tell
    // the client the work did not happen when it did.
    const memory = new MemoryStorage()
    const fencing: IdempotencyStorage = {
      acquire: (record, ttl) => memory.acquire(record, ttl),
      complete: async () => { throw new FencingError('k-1') },
      release: (key, token) => memory.release(key, token),
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const kernel = new HttpIdempotencyKernel(new Idempotency({ storage: fencing }))
    const warnings = await warningsDuring(async () => {
      assert.deepEqual(await kernel.handle(post(), async () => ok()), { kind: 'handled' })
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /k-1|after the response was sent/)
  })

  test('a key the client cannot use answers 400, not 500', async () => {
    // The header is client input: a 5xx here would blame the server and page
    // someone for a malformed request.
    const kernel = kernelWith({}, { maxKeyLength: 16 })
    let calls = 0
    const outcome = await kernel.handle(
      post({ key: 'x'.repeat(20) }),
      async () => { calls += 1; return ok() }
    )
    assert.equal(outcome.kind, 'respond')
    if (outcome.kind === 'respond') {
      assert.equal(outcome.response.status, 400)
      const body = JSON.parse(outcome.response.body) as { error: string, detail: string }
      assert.equal(body.error, 'IDEMPOTENCY_KEY_INVALID')
      assert.match(body.detail, /16/, 'the client is told the limit it broke')
    }
    assert.equal(calls, 0, 'the handler never ran')
  })

  test('failures before the handler runs still map to a status', async () => {
    // Nothing was sent yet, so these can and must become responses.
    const unserializable = kernelWith()
    const outcome = await unserializable.handle(
      { ...post(), body: { fn: () => 'not fingerprintable' } },
      async () => ok()
    )
    assert.equal(outcome.kind, 'respond')
    if (outcome.kind === 'respond') {
      assert.equal(outcome.response.status, 500)
      assert.match(outcome.response.body, /IDEMPOTENCY_SERIALIZATION/)
    }

    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const unavailable = new HttpIdempotencyKernel(new Idempotency({ storage: down }))
    const outage = await unavailable.handle(post(), async () => ok())
    assert.equal(outage.kind === 'respond' && outage.response.status, 503)
  })

  test('problem responses declare a JSON content type and a non-empty detail', async () => {
    const kernel = kernelWith({ retryAfterSeconds: 2 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = kernel.handle(post(), async () => { await gate; return ok() })
    await new Promise((resolve) => setImmediate(resolve))
    const conflict = await kernel.handle(post(), async () => ok())
    release()
    await running

    assert.equal(conflict.kind, 'respond')
    if (conflict.kind === 'respond') {
      assert.match(conflict.response.headers['content-type'] ?? '', /application\/json/)
      const body = JSON.parse(conflict.response.body) as { error: string, detail: string }
      assert.equal(body.error, 'IDEMPOTENCY_IN_PROGRESS')
      assert.notEqual(body.detail, '')
    }

    const strict = kernelWith({ enforce: true })
    const missing = await strict.handle({ ...post(), header: () => undefined }, async () => ok())
    if (missing.kind === 'respond') {
      const body = JSON.parse(missing.response.body) as { detail: string }
      assert.match(body.detail, /idempotency-key/)
      assert.match(body.detail, /POST/)
    }

    const reuse = kernelWith()
    await reuse.handle(post({ body: { amount: 1 } }), async () => ok())
    const rejected = await reuse.handle(post({ body: { amount: 2 } }), async () => ok())
    if (rejected.kind === 'respond') {
      const body = JSON.parse(rejected.response.body) as { detail: string }
      assert.notEqual(body.detail, '')
    }
  })

  test('body-and-path folds an absent body into null', async () => {
    const kernel = kernelWith({ fingerprint: 'body-and-path' })
    let calls = 0
    const run = async () => { calls += 1; return ok() }
    await kernel.handle(post({ body: undefined }), run)
    const second = await kernel.handle(post({ body: null }), run)
    assert.equal(calls, 1)
    assert.equal(second.kind, 'respond')
  })

  test('a stored record holding no response cannot be replayed', async () => {
    // The kernel never stores a null, so only a hand-written or corrupted
    // record reaches this: there is nothing to serve, and answering with an
    // empty shell would be worse than letting the request run.
    const poisoned: IdempotencyStorage = {
      acquire: async () => ({
        token: 't',
        status: 'completed',
        result: 'null',
        storedAt: 1,
        expiresAt: Date.now() + 60_000
      }),
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const kernel = new HttpIdempotencyKernel(new Idempotency({ storage: poisoned }))
    const outcome = await kernel.handle(post({ key: 'k-null', body: undefined }), async () => ok())
    assert.deepEqual(outcome, { kind: 'passthrough' })
  })

  test('an uncacheable response writes no failed record and releases the key', async () => {
    const memory = new MemoryStorage()
    const stored: string[] = []
    let released = 0
    const spy: IdempotencyStorage = {
      acquire: (record, ttl) => memory.acquire(record, ttl),
      complete: async (key, token, outcome, ttl) => {
        if (outcome.status === 'failed') stored.push(outcome.error)
        return memory.complete(key, token, outcome, ttl)
      },
      release: async (key, token) => { released += 1; await memory.release(key, token) },
      extend: (key, token, ttl) => memory.extend(key, token, ttl),
      get: (key) => memory.get(key),
      delete: (key) => memory.delete(key)
    }
    const kernel = new HttpIdempotencyKernel(new Idempotency({ storage: spy, persistFailures: true }))
    await kernel.handle(post({ body: undefined }), async () => null)
    assert.deepEqual(stored, [], 'persistFailures must not turn the sentinel into a record')
    assert.equal(released, 1, 'the record is released, not completed')
  })

  test('custom header and method set are honored', async () => {
    const kernel = kernelWith({ header: 'X-Request-Once', methods: ['PUT'] })
    let calls = 0
    const run = async () => { calls += 1; return ok() }
    const headers: Record<string, string | undefined> = { 'x-request-once': 'cfg-1' }
    const request: HttpRequestFacts = { method: 'PUT', path: '/p', body: { a: 1 }, header: (name) => headers[name] }

    assert.deepEqual(await kernel.handle({ ...request, method: 'POST' }, run), { kind: 'passthrough' })
    assert.deepEqual(await kernel.handle(request, run), { kind: 'handled' })
    const replay = await kernel.handle(request, run)
    assert.equal(calls, 1)
    assert.equal(replay.kind, 'respond')
  })
})

describe('http kernel header selection', () => {
  test('selects string, numeric and array header values and skips the rest', () => {
    const kernel = kernelWith({ replayHeaders: ['content-type', 'content-length', 'location', 'x-empty', 'x-missing'] })
    const values: Record<string, unknown> = {
      'content-type': 'application/json',
      'content-length': 42,
      location: ['first', 'second'],
      'x-empty': '',
      'x-missing': undefined
    }
    assert.deepEqual(kernel.selectHeaders((name) => values[name]), {
      'content-type': 'application/json',
      'content-length': '42',
      location: 'first, second'
    })
  })

  test('skips empty array header values', () => {
    const kernel = kernelWith({ replayHeaders: ['location'] })
    assert.deepEqual(kernel.selectHeaders(() => []), {})
  })
})
