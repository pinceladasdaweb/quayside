// A complete NestJS application protected by quayside, in one file.
// Run with: npm run examples
// In an application, import from 'quayside/nestjs' and 'quayside/memory'.
import 'reflect-metadata'
import assert from 'node:assert/strict'

import { Body, Controller, Module, Post, UseInterceptors } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

import { MemoryStorage } from '../src/memory/index'
import { Idempotent, IdempotencyInterceptor, QuaysideModule } from '../src/nestjs/index'

let executions = 0

@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
class PaymentsController {
  @Post()
  @Idempotent()
  create (@Body() body: { invoiceId: number }) {
    executions += 1
    return { paymentId: `pay-${body.invoiceId}`, executions }
  }
}

@Module({
  imports: [QuaysideModule.forRoot({ storage: new MemoryStorage(), resultTtl: '24h' })],
  controllers: [PaymentsController]
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: false })
await app.listen(0)
const base = (await app.getUrl()).replace('[::1]', '127.0.0.1')

const request = async () => fetch(`${base}/payments`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': 'invoice-123' },
  body: JSON.stringify({ invoiceId: 123 })
})

const first = await request()
const second = await request()

assert.equal(first.status, 201)
assert.equal(second.status, 201)
assert.equal(second.headers.get('idempotency-replayed'), 'true')
assert.deepEqual(await second.json(), { paymentId: 'pay-123', executions: 1 })
assert.equal(executions, 1)

console.log('nestjs example: the handler ran once and the second call replayed')
await app.close()
