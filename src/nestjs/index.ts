import {
  HttpException,
  Inject,
  Injectable,
  Module,
  SetMetadata
} from '@nestjs/common'
import type { Observable } from 'rxjs'
import { defaultIfEmpty, from, lastValueFrom } from 'rxjs'
import type { CallHandler, DynamicModule, ExecutionContext, NestInterceptor } from '@nestjs/common'

// Runtime values come from the core entry point, never from deep module
// paths: error identity (instanceof) must hold against errors thrown by the
// user's Idempotency instance, so the build maps '../index' onto the shipped
// core bundle instead of inlining a private copy.
import { Idempotency } from '../index'
import type { Duration, IdempotencyOptions } from '../index'
import { headerValue, httpErrorFacts } from '../http/kernel'

/** Injection token for the Idempotency instance built by QuaysideModule. */
export const QUAYSIDE_IDEMPOTENCY = 'QUAYSIDE_IDEMPOTENCY'
/** Injection token for the module options (storage, TTLs, header). */
export const QUAYSIDE_MODULE_OPTIONS = 'QUAYSIDE_MODULE_OPTIONS'

// A symbol cannot collide with foreign metadata. Registered rather than
// unique: this package ships dual CJS and ESM builds, and an app that loads
// both would otherwise have the decorator write under one key and the
// interceptor read another, silently leaving every route unprotected.
const IDEMPOTENT_METADATA = Symbol.for('quayside:idempotent')

export interface NestRequestLike {
  headers: Record<string, unknown>
  body?: unknown
}

export interface IdempotentOptions {
  /** Derives the key from the request; defaults to the configured header. */
  key? (request: NestRequestLike): string | undefined
  /** Per-route replay window, overriding the instance resultTtl. */
  ttl?: Duration
  /** Payload fingerprint over the request; false disables it. Default: the request body. */
  fingerprint?: false | ((request: NestRequestLike) => unknown)
  /** Reject requests without a key (400) instead of running unprotected. Default: false. */
  enforce?: boolean
}

export type QuaysideModuleOptions = IdempotencyOptions & {
  /** Header carrying the idempotency key. Default: 'Idempotency-Key'. */
  header?: string
}

export interface QuaysideModuleAsyncOptions {
  imports?: DynamicModule['imports']
  inject?: unknown[]
  useFactory (...args: never[]): QuaysideModuleOptions | Promise<QuaysideModuleOptions>
}

/** Marks a handler as idempotent; enforced by the IdempotencyInterceptor. */
export function Idempotent (options: IdempotentOptions = {}): MethodDecorator {
  return SetMetadata(IDEMPOTENT_METADATA, options)
}

// A persisted failure replays as a reconstruction: the own fields of an
// HttpException survive, its prototype does not, and Nest's exception filter
// answers 500 for anything that is not an instance. Rebuilding one restores
// the status and body the first attempt already answered with: retries of
// the same key must not change the response.
function reviveHttpException (error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof HttpException) return error
  const replayed = error as unknown as { status?: unknown, response?: unknown }
  if (typeof replayed.status !== 'number' || replayed.response === undefined) return error
  return new HttpException(replayed.response as string | Record<string, unknown>, replayed.status)
}

// Platform-neutral: express exposes setHeader, fastify exposes header.
function setResponseHeader (response: unknown, name: string, value: string): void {
  const target = response as {
    setHeader?: (name: string, value: string) => unknown
    header?: (name: string, value: string) => unknown
  }
  if (typeof target.setHeader === 'function') target.setHeader(name, value)
  else if (typeof target.header === 'function') target.header(name, value)
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly headerName: string

  constructor (
    @Inject(QUAYSIDE_IDEMPOTENCY) private readonly idempotency: Idempotency,
    @Inject(QUAYSIDE_MODULE_OPTIONS) private readonly options: QuaysideModuleOptions
  ) {
    this.headerName = (this.options.header ?? 'Idempotency-Key').toLowerCase()
  }

  intercept (context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = Reflect.getMetadata(IDEMPOTENT_METADATA, context.getHandler()) as IdempotentOptions | undefined
    if (metadata === undefined || context.getType() !== 'http') return next.handle()
    return from(this.run(metadata, context, next))
  }

  private async run (options: IdempotentOptions, context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const http = context.switchToHttp()
    const request = http.getRequest<NestRequestLike>()
    const response = http.getResponse<unknown>()

    const key = options.key !== undefined
      ? options.key(request)
      : headerValue(request.headers[this.headerName])
    if (key === undefined || key === '') {
      if (options.enforce === true) {
        throw new HttpException(
          { statusCode: 400, error: 'IDEMPOTENCY_KEY_REQUIRED', message: `the ${this.headerName} header is required` },
          400
        )
      }
      return lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)))
    }

    const payload = options.fingerprint === false
      ? undefined
      : typeof options.fingerprint === 'function'
        ? options.fingerprint(request)
        : request.body

    // Once the handler has produced its value there is a truthful answer to
    // serve, whatever happens to the record afterwards.
    let handlerValue: unknown
    let responded = false
    try {
      const outcome = await this.idempotency.executeWithMetadata(
        { key, payload, resultTtl: options.ttl },
        async (ctx) => {
          try {
            const value = await lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)))
            handlerValue = value
            responded = true
            // The kernel gates on the captured status; the value-level
            // equivalent reads the platform response the interceptor
            // already holds. A passthrough handler that declared a server
            // status (res.status(503) and a returned body) is answering
            // with a transient error, which must never persist as a
            // replayable success.
            // Number() rather than a type guard: a platform whose status
            // reads as 5xx is answering with a server error however it
            // spells it, and an absent status is NaN, which compares false.
            if (Number((response as { statusCode?: unknown }).statusCode) >= 500) ctx.doNotStore()
            return value
          } catch (error) {
            // The kernel's rule, applied at the value level: a response
            // that declares a server status is transient by definition and
            // must never persist as a replayable failure. Under
            // persistFailures a stored 500 would answer every retry until
            // the result TTL ran out; releasing instead lets the retry
            // re-execute under a fresh lock. A plain thrown error keeps the
            // core persistFailures contract (domain failures replay): only
            // an exception that names its own server status is overruled.
            if (error instanceof HttpException && error.getStatus() >= 500) ctx.doNotStore()
            throw error
          }
        }
      )
      if (outcome.replayed) setResponseHeader(response, 'idempotency-replayed', 'true')
      return outcome.value
    } catch (error) {
      if (responded) {
        // A settlement failure after the handler succeeded (a lock that
        // outlived a slow execution, a storage that died on the completion
        // write). Answering 500 would discard work that completed, and the
        // retry would run the side effect again believing nothing happened.
        // The computed value is the truthful answer; the failure is
        // reported, and since nothing was stored a retry re-executes,
        // exactly the kernel's rule after a response was sent.
        process.emitWarning(`quayside could not settle the record for "${key}" after the handler completed: ${String(error)}`)
        return handlerValue
      }
      throw this.mapError(error, response)
    }
  }

  private mapError (error: unknown, response: unknown): unknown {
    // The kernel's error table, rendered as Nest's exception shape: what a
    // client is told cannot depend on which adapter answered.
    const facts = httpErrorFacts(error)
    if (facts === null) return reviveHttpException(error)
    if (facts.retryAfter) setResponseHeader(response, 'retry-after', '1')
    return new HttpException({ statusCode: facts.status, error: facts.code, message: facts.message }, facts.status)
  }
}

@Module({})
export class QuaysideModule {
  static forRoot (options: QuaysideModuleOptions & { global?: boolean }): DynamicModule {
    const { global, ...moduleOptions } = options
    return {
      module: QuaysideModule,
      global: global ?? true,
      providers: [
        { provide: QUAYSIDE_MODULE_OPTIONS, useValue: moduleOptions },
        { provide: QUAYSIDE_IDEMPOTENCY, useFactory: (resolved: QuaysideModuleOptions) => new Idempotency(resolved), inject: [QUAYSIDE_MODULE_OPTIONS] },
        IdempotencyInterceptor
      ],
      exports: [QUAYSIDE_IDEMPOTENCY, QUAYSIDE_MODULE_OPTIONS, IdempotencyInterceptor]
    }
  }

  static forRootAsync (options: QuaysideModuleAsyncOptions): DynamicModule {
    return {
      module: QuaysideModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: QUAYSIDE_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject as never[] ?? [] },
        { provide: QUAYSIDE_IDEMPOTENCY, useFactory: (resolved: QuaysideModuleOptions) => new Idempotency(resolved), inject: [QUAYSIDE_MODULE_OPTIONS] },
        IdempotencyInterceptor
      ],
      exports: [QUAYSIDE_IDEMPOTENCY, QUAYSIDE_MODULE_OPTIONS, IdempotencyInterceptor]
    }
  }
}
