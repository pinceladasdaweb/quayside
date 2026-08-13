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
        return true
      }
    )
  })

  test('module builders honor global, imports and inject options', async () => {
    const scoped = QuaysideModule.forRoot({ storage: new MemoryStorage(), global: false })
    assert.equal(scoped.global, false)
    const globalByDefault = QuaysideModule.forRoot({ storage: new MemoryStorage() })
    assert.equal(globalByDefault.global, true)

    const asyncModule = QuaysideModule.forRootAsync({
      imports: [],
      inject: [],
      useFactory: () => ({ storage: new MemoryStorage() })
    })
    assert.deepEqual(asyncModule.imports, [])
    assert.equal(asyncModule.global, true)
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
