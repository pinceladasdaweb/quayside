// Type-checked against the BUILT declarations (dist/), the way a consumer
// sees the package, never against src/. The unit suite loads src/ through
// tsx, so it cannot notice a declaration bundle that inlines its own copy of
// a class: a class with private members is nominal, and an Idempotency
// declared twice (once in index.d.ts, once inside express.d.ts) made
// `ExpressMiddleware(new Idempotency(...))` a type error for every consumer
// while every test passed. This file is the gate for that: `npm run
// check:dist` builds and compiles it.
import { Idempotency } from 'quayside'
import { MemoryStorage } from 'quayside/memory'
import { ExpressMiddleware } from 'quayside/express'
import { FastifyPlugin } from 'quayside/fastify'
import { HonoMiddleware } from 'quayside/hono'
import { QuaysideModule } from 'quayside/nestjs'
import type { IdempotencyStorage } from 'quayside'

const storage: IdempotencyStorage = new MemoryStorage()
const idempotency = new Idempotency({ storage })

export const express = ExpressMiddleware(idempotency)
export const fastify = FastifyPlugin(idempotency)
export const hono = HonoMiddleware(idempotency)
export const nest = QuaysideModule.forRoot({ storage })
