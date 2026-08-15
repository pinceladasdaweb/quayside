import 'reflect-metadata'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { Body, Controller, Post, UseInterceptors } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { Idempotency } from '../../src/index'
import type { IdempotencyStorage } from '../../src/index'
import { MemoryStorage } from '../../src/memory/index'
import { Idempotent, IdempotencyInterceptor, QuaysideModule } from '../../src/nestjs/index'
import type { NestRequestLike } from '../../src/nestjs/index'

let app: INestApplication
let base: string
let calls: Record<string, number>
let release: () => void = () => {}

@Controller()
@UseInterceptors(IdempotencyInterceptor)
class PaymentsController {
  @Post('payments')
  @Idempotent()
  create (@Body() body: { amount: number }) {
    calls.payments = (calls.payments ?? 0) + 1
    return { id: 1, amount: body.amount }
  }

  @Post('slow')
  @Idempotent()
  async slow () {
    calls.slow = (calls.slow ?? 0) + 1
    await new Promise<void>((resolve) => { release = resolve })
    return { done: true }
  }

  @Post('custom-key')
  @Idempotent({ key: (request: NestRequestLike) => (request.body as { orderId?: string }).orderId, fingerprint: false })
  customKey () {
    calls.custom = (calls.custom ?? 0) + 1
    return { ok: true }
  }

  @Post('short-ttl')
  @Idempotent({ ttl: '60ms' })
  shortTtl () {
    calls.shortTtl = (calls.shortTtl ?? 0) + 1
    return { ok: true }
  }

  @Post('strict')
  @Idempotent({ enforce: true })
  strict () {
    calls.strict = (calls.strict ?? 0) + 1
    return { ok: true }
  }

  @Post('plain')
  plain () {
    calls.plain = (calls.plain ?? 0) + 1
    return { ok: true }
  }
}

before(async () => {
  calls = {}
  const moduleRef = await Test.createTestingModule({
    imports: [QuaysideModule.forRoot({ storage: new MemoryStorage() })],
    controllers: [PaymentsController]
  }).compile()
  app = moduleRef.createNestApplication()
  await app.listen(0)
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1')
})

after(async () => {
  await app.close()
})

async function post (path: string, key: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== undefined) headers['idempotency-key'] = key
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('nestjs adapter', () => {
  test('replays the handler result with the replay marker', async () => {
    const first = await post('/payments', 'nest-1', { amount: 10 })
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('idempotency-replayed'), null)

    const second = await post('/payments', 'nest-1', { amount: 10 })
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await second.json(), { id: 1, amount: 10 })
    assert.equal(calls.payments, 1)
  })

  test('the same key with a different body responds 422', async () => {
    await post('/payments', 'nest-2', { amount: 10 })
    const conflict = await post('/payments', 'nest-2', { amount: 99 })
    assert.equal(conflict.status, 422)
    assert.match(await conflict.text(), /IDEMPOTENCY_KEY_REUSE/)
  })

  test('concurrent execution responds 409 with Retry-After', async () => {
    const running = post('/slow', 'nest-3', {})
    await sleep(100)
    const conflict = await post('/slow', 'nest-3', {})
    assert.equal(conflict.status, 409)
    assert.equal(conflict.headers.get('retry-after'), '1')
    release()
    assert.equal((await running).status, 201)
  })

  test('a custom key extractor replaces the header', async () => {
    await post('/custom-key', undefined, { orderId: 'o-1' })
    await post('/custom-key', undefined, { orderId: 'o-1' })
    await post('/custom-key', undefined, { orderId: 'o-2' })
    assert.equal(calls.custom, 2)
  })

  test('a per-route ttl expires the replay window', async () => {
    await post('/short-ttl', 'nest-4', {})
    await post('/short-ttl', 'nest-4', {})
    assert.equal(calls.shortTtl, 1)
    await sleep(90)
    await post('/short-ttl', 'nest-4', {})
    assert.equal(calls.shortTtl, 2)
  })

  test('enforce rejects requests without a key', async () => {
    const rejected = await post('/strict', undefined, {})
    assert.equal(rejected.status, 400)
    assert.match(await rejected.text(), /IDEMPOTENCY_KEY_REQUIRED/)
    assert.equal(calls.strict, undefined)
  })

  test('a decorated route without a key runs unprotected by default', async () => {
    const startingCalls = calls.payments ?? 0
    await post('/payments', undefined, { amount: 1 })
    await post('/payments', undefined, { amount: 1 })
    assert.equal(calls.payments, startingCalls + 2)
  })

  test('undecorated routes are untouched', async () => {
    await post('/plain', 'nest-5', {})
    await post('/plain', 'nest-5', {})
    assert.equal(calls.plain, 2)
  })

  test('forRootAsync builds the module from a factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        QuaysideModule.forRootAsync({
          useFactory: async () => ({ storage: new MemoryStorage(), header: 'X-Once' })
        })
      ],
      controllers: [PaymentsController]
    }).compile()
    const asyncApp = moduleRef.createNestApplication()
    await asyncApp.listen(0)
    const url = (await asyncApp.getUrl()).replace('[::1]', '127.0.0.1')

    const request = async () => fetch(`${url}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-once': 'async-1' },
      body: JSON.stringify({ amount: 3 })
    })
    const startingCalls = calls.payments ?? 0
    await request()
    const second = await request()
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(calls.payments, startingCalls + 1)
    await asyncApp.close()
  })
})

describe('nestjs interceptor glue', () => {
  function fakeContext (headers: Record<string, unknown>, response: unknown, handler: () => unknown) {
    return {
      getType: () => 'http',
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ headers, body: { n: 1 } }),
        getResponse: () => response
      })
    }
  }

  function decorated (options: Parameters<typeof Idempotent>[0] = {}) {
    const handler = () => 'handled'
    Idempotent(options)({}, 'handler', { value: handler })
    return handler
  }

  async function intercept (
    interceptor: IdempotencyInterceptor,
    context: ReturnType<typeof fakeContext>,
    result: unknown = 'fresh'
  ): Promise<unknown> {
    const { lastValueFrom, of } = await import('rxjs')
    return lastValueFrom(
      interceptor.intercept(context as never, { handle: () => of(result) })
    )
  }

  test('takes the first value of an array header and sets fastify-style headers', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()
    const headersSet: Record<string, string> = {}
    const fastifyStyleResponse = { header: (name: string, value: string) => { headersSet[name] = value } }

    const context = fakeContext({ 'idempotency-key': ['arr-1', 'ignored'] }, fastifyStyleResponse, handler)
    assert.equal(await intercept(interceptor, context, 'first'), 'first')
    assert.equal(await intercept(interceptor, context, 'second'), 'first')
    assert.equal(headersSet['idempotency-replayed'], 'true')
  })

  test('sets the replay marker through express-style setHeader responses', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()
    const headersSet: Record<string, string> = {}
    const expressStyleResponse = { setHeader: (name: string, value: string) => { headersSet[name] = value } }

    const context = fakeContext({ 'idempotency-key': 'exp-1' }, expressStyleResponse, handler)
    assert.equal(await intercept(interceptor, context, 'first'), 'first')
    assert.equal(await intercept(interceptor, context, 'second'), 'first')
    assert.equal(headersSet['idempotency-replayed'], 'true')
  })

  test('the metadata key is shared across module copies', () => {
    // The package ships dual CJS and ESM builds. A registered symbol is what
    // keeps the decorator and the interceptor talking when an app loads
    // both: a second copy resolves the very same key by name, where a unique
    // Symbol() would silently read nothing and leave the route unprotected.
    const handler = decorated({ ttl: '5m' })
    const fromOtherCopy = Reflect.getMetadata(Symbol.for('quayside:idempotent'), handler) as { ttl?: string } | undefined
    assert.deepEqual(fromOtherCopy, { ttl: '5m' })
  })

  test('a replayed HttpException keeps the status of the first attempt', async () => {
    const { HttpException, NotFoundException } = await import('@nestjs/common')
    const { lastValueFrom } = await import('rxjs')
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, persistFailures: true })
    const interceptor = new IdempotencyInterceptor(idempotency, { storage, persistFailures: true })
    const handler = decorated()
    const context = fakeContext({ 'idempotency-key': 'nest-404' }, {}, handler)

    const first = await assert.rejects(
      lastValueFrom(interceptor.intercept(context as never, {
        handle: () => { throw new NotFoundException('no such invoice') }
      })),
      (error: unknown) => {
        assert.ok(error instanceof HttpException)
        assert.equal(error.getStatus(), 404)
        return true
      }
    ).then(() => true)
    assert.equal(first, true)

    // The retry replays a reconstruction: without rebuilding the exception
    // Nest's filter would answer 500 for the request that first got a 404.
    await assert.rejects(
      intercept(interceptor, context),
      (error: unknown) => {
        assert.ok(error instanceof HttpException, 'the replayed failure is still an HttpException')
        assert.equal(error.getStatus(), 404)
        const body = error.getResponse() as { message: string }
        assert.equal(body.message, 'no such invoice')
        return true
      }
    )
  })

  test('an oversized key answers 400, not 500', async () => {
    const { HttpException } = await import('@nestjs/common')
    const options = { storage: new MemoryStorage(), maxKeyLength: 16 }
    const interceptor = new IdempotencyInterceptor(new Idempotency(options), options)
    const context = fakeContext({ 'idempotency-key': 'x'.repeat(20) }, {}, decorated())

    await assert.rejects(intercept(interceptor, context), (error: unknown) => {
      assert.ok(error instanceof HttpException)
      assert.equal(error.getStatus(), 400)
      const body = error.getResponse() as { error: string, message: string }
      assert.equal(body.error, 'IDEMPOTENCY_KEY_INVALID')
      assert.match(body.message, /16/)
      return true
    })
  })

  test('only a complete http shape is rebuilt as an HttpException', async () => {
    // Both halves are required: a status with no body has nothing to answer
    // with, and a body with no numeric status has no status to answer under.
    const { HttpException } = await import('@nestjs/common')
    const { lastValueFrom } = await import('rxjs')
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()

    const halves = [
      { label: 'status without a response', error: Object.assign(new Error('half a'), { status: 418 }) },
      { label: 'response without a numeric status', error: Object.assign(new Error('half b'), { response: { message: 'x' }, status: 'teapot' }) }
    ]
    for (const [index, { label, error }] of halves.entries()) {
      const context = fakeContext({ 'idempotency-key': `nest-half-${index}` }, {}, handler)
      await assert.rejects(
        lastValueFrom(interceptor.intercept(context as never, { handle: () => { throw error } })),
        (thrown: unknown) => {
          assert.equal(thrown, error, `${label} must pass through untouched`)
          assert.ok(!(thrown instanceof HttpException))
          return true
        }
      )
    }
  })

  test('replayed errors without an http shape pass through untouched', async () => {
    const { lastValueFrom } = await import('rxjs')
    const storage = new MemoryStorage()
    const idempotency = new Idempotency({ storage, persistFailures: true })
    const interceptor = new IdempotencyInterceptor(idempotency, { storage, persistFailures: true })
    const handler = decorated()
    const context = fakeContext({ 'idempotency-key': 'nest-plain' }, {}, handler)
    const domainError = Object.assign(new Error('card declined'), { code: 'CARD_DECLINED' })

    await assert.rejects(lastValueFrom(interceptor.intercept(context as never, {
      handle: () => { throw domainError }
    })), /card declined/)

    await assert.rejects(intercept(interceptor, context), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'CARD_DECLINED')
      assert.equal(error.constructor.name, 'Error', 'a plain domain failure is not dressed up as an HttpException')
      return true
    })
  })

  test('a non-string, non-array header value runs unprotected', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()
    const context = fakeContext({ 'idempotency-key': 7 }, {}, handler)
    assert.equal(await intercept(interceptor, context, 'r1'), 'r1')
    assert.equal(await intercept(interceptor, context, 'r2'), 'r2', 'a malformed header value must not become a key')
  })

  test('maps fencing and storage failures onto 500 and 503', async () => {
    const { HttpException } = await import('@nestjs/common')
    const { FencingError } = await import('../../src/index')

    const fencing: IdempotencyStorage = {
      acquire: async () => null,
      complete: async () => { throw new FencingError('k') },
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: fencing }),
      { storage: fencing }
    )
    const handler = decorated()
    await assert.rejects(
      intercept(interceptor, fakeContext({ 'idempotency-key': 'f-1' }, {}, handler)),
      (error: unknown) => {
        assert.ok(error instanceof HttpException)
        assert.equal(error.getStatus(), 500)
        const body = error.getResponse() as { statusCode: number, error: string, message: string }
        assert.equal(body.statusCode, 500)
        assert.equal(body.error, 'IDEMPOTENCY_FENCING')
        assert.notEqual(body.message, '')
        return true
      }
    )

    const down: IdempotencyStorage = {
      acquire: async () => { throw new Error('down') },
      complete: async () => {},
      release: async () => {},
      extend: async () => {},
      get: async () => null,
      delete: async () => {}
    }
    const unavailable = new IdempotencyInterceptor(
      new Idempotency({ storage: down }),
      { storage: down }
    )
    await assert.rejects(
      intercept(unavailable, fakeContext({ 'idempotency-key': 'f-2' }, {}, decorated())),
      (error: unknown) => {
        assert.ok(error instanceof HttpException)
        assert.equal(error.getStatus(), 503)
        const body = error.getResponse() as { statusCode: number, error: string, message: string }
        assert.equal(body.statusCode, 503)
        assert.equal(body.error, 'IDEMPOTENCY_STORAGE_UNAVAILABLE')
        assert.notEqual(body.message, '')
        return true
      }
    )
  })

  test('module builders honor global, imports and inject options', async () => {
    const scoped = QuaysideModule.forRoot({ storage: new MemoryStorage(), global: false })
    assert.equal(scoped.global, false)
    const globalByDefault = QuaysideModule.forRoot({ storage: new MemoryStorage() })
    assert.equal(globalByDefault.global, true)

    // Omitted imports/inject must materialize as empty arrays, not undefined.
    const bare = QuaysideModule.forRootAsync({ useFactory: () => ({ storage: new MemoryStorage() }) })
    assert.deepEqual(bare.imports, [])
    assert.equal(bare.global, true)
    const bareOptionsProvider = (bare.providers ?? [])[0] as { inject?: unknown[] }
    assert.deepEqual(bareOptionsProvider.inject, [])
  })

  test('a custom key extractor returning nothing runs unprotected', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated({ key: () => '' })
    const context = fakeContext({}, {}, handler)
    assert.equal(await intercept(interceptor, context, 'ran-1'), 'ran-1')
    assert.equal(await intercept(interceptor, context, 'ran-2'), 'ran-2')
  })

  test('routes without a ttl override use the module resultTtl', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage(), resultTtl: '60ms' }),
      { storage: new MemoryStorage(), resultTtl: '60ms' }
    )
    const handler = decorated()
    const context = fakeContext({ 'idempotency-key': 'ttl-base' }, {}, handler)
    assert.equal(await intercept(interceptor, context, 'first'), 'first')
    await new Promise((resolve) => setTimeout(resolve, 90))
    assert.equal(await intercept(interceptor, context, 'second'), 'second', 'the 60ms window has expired')
  })

  test('fingerprint false and custom fingerprint functions bypass the body', async () => {
    const storage = new MemoryStorage()
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage }),
      { storage }
    )
    const disabled = decorated({ fingerprint: false })
    const bodies = [{ n: 1 }, { n: 2 }]
    let call = 0
    const shifting = {
      getType: () => 'http',
      getHandler: () => disabled,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'idempotency-key': 'fp-off' }, body: bodies[call++] }),
        getResponse: () => ({})
      })
    }
    assert.equal(await intercept(interceptor, shifting as never, 'a'), 'a')
    assert.equal(await intercept(interceptor, shifting as never, 'b'), 'a', 'different bodies replay when fingerprinting is off')

    const custom = decorated({ fingerprint: () => 'constant' })
    let customCall = 0
    const customContext = {
      getType: () => 'http',
      getHandler: () => custom,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'idempotency-key': 'fp-fn' }, body: bodies[customCall++] }),
        getResponse: () => ({})
      })
    }
    assert.equal(await intercept(interceptor, customContext as never, 'x'), 'x')
    assert.equal(await intercept(interceptor, customContext as never, 'y'), 'x')
  })

  test('foreign HttpExceptions pass through unwrapped', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()
    const { HttpException } = await import('@nestjs/common')
    const { lastValueFrom, throwError } = await import('rxjs')
    const teapot = new HttpException('short and stout', 418)
    await assert.rejects(
      lastValueFrom(interceptor.intercept(
        fakeContext({ 'idempotency-key': 'teapot' }, {}, handler) as never,
        { handle: () => throwError(() => teapot) }
      )),
      (error: unknown) => {
        assert.equal(error, teapot, 'application exceptions are rethrown as-is, never rewrapped')
        return true
      }
    )
  })

  test('error responses carry the code and a non-empty message', async () => {
    const conflict = await (async () => {
      const running = post('/slow', 'nest-body-409', {})
      await sleep(100)
      const response = await post('/slow', 'nest-body-409', {})
      release()
      await running
      return response
    })()
    const body409 = await conflict.json() as { error: string, message: string }
    assert.equal(body409.error, 'IDEMPOTENCY_IN_PROGRESS')
    assert.notEqual(body409.message, '')

    await post('/payments', 'nest-body-422', { amount: 1 })
    const reuse = await post('/payments', 'nest-body-422', { amount: 2 })
    const body422 = await reuse.json() as { error: string, message: string }
    assert.equal(body422.error, 'IDEMPOTENCY_KEY_REUSE')
    assert.notEqual(body422.message, '')

    const missing = await post('/strict', undefined, {})
    const body400 = await missing.json() as { error: string, message: string }
    assert.equal(body400.error, 'IDEMPOTENCY_KEY_REQUIRED')
    assert.match(body400.message, /idempotency-key/)
  })

  test('empty handler observables resolve to undefined', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const { lastValueFrom, EMPTY } = await import('rxjs')
    const decoratedHandler = decorated()
    const value = await lastValueFrom(interceptor.intercept(
      fakeContext({ 'idempotency-key': 'empty-obs' }, {}, decoratedHandler) as never,
      { handle: () => EMPTY }
    ))
    assert.equal(value, undefined)

    const noKey = await lastValueFrom(interceptor.intercept(
      fakeContext({}, {}, decoratedHandler) as never,
      { handle: () => EMPTY }
    ))
    assert.equal(noKey, undefined)
  })

  test('an empty-string header runs unprotected', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const handler = decorated()
    const context = fakeContext({ 'idempotency-key': '' }, {}, handler)
    assert.equal(await intercept(interceptor, context, 'r1'), 'r1')
    assert.equal(await intercept(interceptor, context, 'r2'), 'r2')
  })

  test('non-http contexts pass through untouched', async () => {
    const interceptor = new IdempotencyInterceptor(
      new Idempotency({ storage: new MemoryStorage() }),
      { storage: new MemoryStorage() }
    )
    const { lastValueFrom, of } = await import('rxjs')
    const context = { getType: () => 'rpc', getHandler: () => decorated() }
    assert.equal(
      await lastValueFrom(interceptor.intercept(context as never, { handle: () => of('rpc-result') })),
      'rpc-result'
    )
  })
})
