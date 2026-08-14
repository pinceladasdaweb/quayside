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
  app.post('/stream', (_req, res) => {
    calls.stream = (calls.stream ?? 0) + 1
    res.status(200).type('text/plain')
    res.write('hello ', 'utf8')
    res.write(Buffer.from('streamed '))
    res.end('world')
  })
  app.post('/base64', (_req, res) => {
    calls.base64 = (calls.base64 ?? 0) + 1
    res.status(200).type('text/plain')
    res.write('aGk=', 'base64')
    res.end()
  })
  app.post('/no-body', (_req, res) => {
    calls.noBody = (calls.noBody ?? 0) + 1
    res.status(204).end()
  })
  app.post('/exact', (_req, res) => {
    calls.exact = (calls.exact ?? 0) + 1
    res.status(200).send('x'.repeat(1_024))
  })
  app.post('/tail', (_req, res) => {
    calls.tail = (calls.tail ?? 0) + 1
    res.status(200)
    res.write('y'.repeat(1_100))
    res.end('tail')
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

  test('responses written in chunks are captured whole and replayed', async () => {
    const first = await post('/stream', 'exp-stream', {})
    assert.equal(await first.text(), 'hello streamed world')
    const second = await post('/stream', 'exp-stream', {})
    assert.equal(await second.text(), 'hello streamed world')
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.stream, 1)
  })

  test('write encodings are honored in the captured body', async () => {
    await post('/base64', 'exp-b64', {})
    const replay = await post('/base64', 'exp-b64', {})
    assert.equal(await replay.text(), 'hi')
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.base64, 1)
  })

  test('bodyless responses replay as empty bodies', async () => {
    const first = await post('/no-body', 'exp-204', {})
    assert.equal(first.status, 204)
    const second = await post('/no-body', 'exp-204', {})
    assert.equal(second.status, 204)
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.noBody, 1)
  })

  test('a body of exactly maxBodyBytes is cached', async () => {
    await post('/exact', 'exp-exact', {})
    const replay = await post('/exact', 'exp-exact', {})
    assert.equal((await replay.text()).length, 1_024)
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.exact, 1)
  })

  test('chunks after an overflow are served but never partially cached', async () => {
    const first = await post('/tail', 'exp-tail', {})
    assert.equal((await first.text()).length, 1_104)
    const second = await post('/tail', 'exp-tail', {})
    assert.equal((await second.text()).length, 1_104, 'a replay of only the post-overflow tail would betray the capture')
    assert.equal(calls.tail, 2)
  })
})

describe('express adapter glue', () => {
  function fakeResponse () {
    const headers: Record<string, string> = {}
    const res = {
      statusCode: 200,
      body: '',
      setHeader (name: string, value: string) { headers[name] = value },
      getHeader (name: string) { return headers[name] },
      write (chunk: unknown) {
        res.body += String(chunk)
        return true
      },
      end (chunk?: unknown, ..._args: unknown[]) {
        if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') res.body += String(chunk)
        return res
      },
      headers
    }
    return res
  }

  test('takes the first value of an array header', async () => {
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const middleware = ExpressMiddleware(idempotency)
    let handled = 0
    const request = {
      method: 'POST',
      path: '/fake',
      body: { n: 1 },
      headers: { 'idempotency-key': ['array-key', 'ignored'] }
    }

    const roundTrip = async () => await new Promise<ReturnType<typeof fakeResponse>>((resolve) => {
      const res = fakeResponse()
      middleware(request, res, () => {
        handled += 1
        res.statusCode = 201
        res.end('created')
        setImmediate(() => resolve(res))
      })
      // replays respond without calling next
      setImmediate(() => setImmediate(() => resolve(res)))
    })

    await roundTrip()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const replayed = await roundTrip()
    assert.equal(handled, 1)
    assert.equal(replayed.headers['idempotency-replayed'], 'true')
    assert.equal(replayed.body, 'created')
  })

  test('distinct string keys never collapse onto their first character', async () => {
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const middleware = ExpressMiddleware(idempotency)
    let handled = 0
    const roundTrip = async (key: string) => await new Promise<void>((resolve) => {
      const res = fakeResponse()
      middleware(
        { method: 'POST', path: '/fake', body: undefined, headers: { 'idempotency-key': key } },
        res,
        () => {
          handled += 1
          res.end('ok')
          setImmediate(resolve)
        }
      )
      setImmediate(() => setImmediate(resolve))
    })
    await roundTrip('aa')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await roundTrip('ab')
    assert.equal(handled, 2, 'keys sharing a first character are different keys')
  })

  test('a non-string, non-array header value runs unprotected', async () => {
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const middleware = ExpressMiddleware(idempotency)
    let handled = 0
    const nextErrors: unknown[] = []
    const roundTrip = async () => await new Promise<void>((resolve) => {
      const res = fakeResponse()
      middleware(
        { method: 'POST', path: '/fake', body: undefined, headers: { 'idempotency-key': 42 } },
        res,
        (error?: unknown) => {
          nextErrors.push(error)
          handled += 1
          res.end('ok')
          setImmediate(resolve)
        }
      )
      setImmediate(() => setImmediate(resolve))
    })
    await roundTrip()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await roundTrip()
    assert.equal(handled, 2, 'a malformed header value must not become a key')
    assert.deepEqual(nextErrors, [undefined, undefined], 'the pass-through is clean, not an error hand-off')
  })

  test('the capture survives every res.end signature node accepts', async () => {
    const idempotency = new Idempotency({ storage: new MemoryStorage() })
    const middleware = ExpressMiddleware(idempotency)
    const settle = async (key: string, finish: (res: ReturnType<typeof fakeResponse>) => void) => {
      const res = fakeResponse()
      await new Promise<void>((resolve) => {
        middleware(
          { method: 'POST', path: '/fake', body: undefined, headers: { 'idempotency-key': key } },
          res,
          () => {
            finish(res)
            setImmediate(resolve)
          }
        )
        setImmediate(() => setImmediate(resolve))
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      return res
    }

    // end(null): no body chunk, cached as an empty body
    await settle('sig-null', (res) => res.end(null))
    const nullReplay = await settle('sig-null', (res) => res.end('would-be-fresh'))
    assert.equal(nullReplay.headers['idempotency-replayed'], 'true')

    // end(chunk, callback): the callback lands in the encoding slot
    await settle('sig-cb', (res) => res.end('done', () => {}))
    const callbackReplay = await settle('sig-cb', (res) => res.end('other', () => {}))
    assert.equal(callbackReplay.headers['idempotency-replayed'], 'true')
    assert.equal(callbackReplay.body, 'done')

    // end(callback): a function chunk is not a body
    await settle('sig-fn', (res) => res.end(() => {}))
    const functionReplay = await settle('sig-fn', (res) => res.end(() => {}))
    assert.equal(functionReplay.headers['idempotency-replayed'], 'true')
    assert.equal(functionReplay.body, '')
  })

  test('forwards a replayed persisted failure to the error chain', async () => {
    const storage = new MemoryStorage()
    await storage.acquire({ key: 'poisoned', token: 't', storedAt: Date.now() }, 60_000)
    await storage.complete('poisoned', 't', {
      status: 'failed',
      error: JSON.stringify({ name: 'PaymentDeclinedError', message: 'card declined' })
    }, 60_000)

    const idempotency = new Idempotency({ storage, persistFailures: true })
    const middleware = ExpressMiddleware(idempotency)
    const forwarded = await new Promise<unknown>((resolve) => {
      middleware(
        { method: 'POST', path: '/fake', body: undefined, headers: { 'idempotency-key': 'poisoned' } },
        fakeResponse(),
        (error?: unknown) => resolve(error)
      )
    })
    assert.ok(forwarded instanceof Error)
    assert.equal(forwarded.message, 'card declined')
  })
})
