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

// Runtime imports come from '../index' on purpose: see the note above the
// storage exports in src/index.ts.
import { Idempotency, isReplayedError } from '../index'
import type { Duration, IdempotencyOptions } from '../index'
import {
  DEFAULT_HEADER,
  DEFAULT_RETRY_AFTER_SECONDS,
  KEY_REQUIRED_CODE,
  REPLAYED_HEADER,
  hasKey,
  headerValue,
  httpErrorFacts,
  isServerError,
  keyRequiredMessage,
  settlementWarning
} from '../http/kernel'

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
  /** The HTTP method, when the platform exposes it; names the scope in the enforce message. */
  method?: string
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
  /** Retry-After hint on 409 responses, in seconds. Default: 1. */
  retryAfterSeconds?: number
}

export interface QuaysideModuleAsyncOptions {
  imports?: DynamicModule['imports']
  inject?: unknown[]
  useFactory (...args: never[]): QuaysideModuleOptions | Promise<QuaysideModuleOptions>
  /** Register the module globally. Default: true, matching forRoot. */
  global?: boolean
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
//
// Gated on isReplayedError: a LIVE foreign error can carry the same two
// fields by coincidence - an AxiosError holds its upstream response and
// status - and rebuilding one of those would answer the client with the
// upstream's status and leak its entire response (headers and request
// config included) instead of the sanitized 500 Nest gives unrecognized
// errors. Only an error decoded from a stored record is a replay.
function reviveHttpException (error: unknown): unknown {
  // The mark subsumes the older instanceof guards: a non-Error is never
  // marked, a live HttpException is never marked, and a reconstruction is
  // never an HttpException instance (that is the problem being solved).
  if (!isReplayedError(error)) return error
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

  private readonly retryAfterSeconds: number

  constructor (
    @Inject(QUAYSIDE_IDEMPOTENCY) private readonly idempotency: Idempotency,
    @Inject(QUAYSIDE_MODULE_OPTIONS) options: QuaysideModuleOptions
  ) {
    this.headerName = (options.header ?? DEFAULT_HEADER).toLowerCase()
    this.retryAfterSeconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS
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
    if (!hasKey(key)) {
      if (options.enforce === true) {
        throw new HttpException(
          {
            statusCode: 400,
            error: KEY_REQUIRED_CODE,
            message: keyRequiredMessage(this.headerName, { method: request.method, derived: options.key !== undefined })
          },
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
            // The kernel's rule at the value level: the platform response
            // the interceptor already holds carries the status. A
            // passthrough handler that declared a server status
            // (res.status(503) and a returned body) is answering with a
            // transient error, which must never persist as a replayable
            // success.
            if (isServerError((response as { statusCode?: unknown }).statusCode)) ctx.doNotStore()
            return value
          } catch (error) {
            // The same rule for a thrown exception: under persistFailures a
            // stored 500 would answer every retry until the result TTL ran
            // out; releasing instead lets the retry re-execute under a
            // fresh lock. A plain thrown error keeps the core
            // persistFailures contract (domain failures replay): only an
            // exception that names its own server status is overruled.
            if (error instanceof HttpException && isServerError(error.getStatus())) ctx.doNotStore()
            throw error
          }
        }
      )
      if (outcome.replayed) setResponseHeader(response, REPLAYED_HEADER, 'true')
      return outcome.value
    } catch (error) {
      if (responded) {
        // A settlement failure after the handler succeeded. Answering 500
        // would discard work that completed, and the retry would run the
        // side effect again believing nothing happened: the computed value
        // is the truthful answer, exactly the kernel's rule.
        process.emitWarning(settlementWarning(key, error))
        return handlerValue
      }
      // A persisted failure replays as a throw, and a replay is a replay
      // whatever its outcome: the marker goes out with it, as it does with
      // a replayed value.
      if (isReplayedError(error)) setResponseHeader(response, REPLAYED_HEADER, 'true')
      throw this.mapError(error, response)
    }
  }

  private mapError (error: unknown, response: unknown): unknown {
    // The kernel's error table, rendered as Nest's exception shape: what a
    // client is told cannot depend on which adapter answered.
    const facts = httpErrorFacts(error)
    if (facts === null) return reviveHttpException(error)
    if (facts.retryAfter) setResponseHeader(response, 'retry-after', String(this.retryAfterSeconds))
    return new HttpException({ statusCode: facts.status, error: facts.code, message: facts.message }, facts.status)
  }
}

// The Nest provider descriptor for the options, whichever way they arrive.
type OptionsProvider =
  | { provide: string, useValue: QuaysideModuleOptions }
  | { provide: string, useFactory: QuaysideModuleAsyncOptions['useFactory'], inject: never[] }

@Module({})
export class QuaysideModule {
  static forRoot (options: QuaysideModuleOptions & { global?: boolean }): DynamicModule {
    const { global, ...moduleOptions } = options
    return QuaysideModule.assemble(
      { provide: QUAYSIDE_MODULE_OPTIONS, useValue: moduleOptions },
      { global }
    )
  }

  static forRootAsync (options: QuaysideModuleAsyncOptions): DynamicModule {
    return QuaysideModule.assemble(
      { provide: QUAYSIDE_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject as never[] ?? [] },
      { global: options.global, imports: options.imports }
    )
  }

  // Both statics differ only in how the options provider is built and what
  // it needs imported; everything else is one module shape, assembled here
  // so a provider added later cannot ship in one static and not the other.
  private static assemble (
    optionsProvider: OptionsProvider,
    context: { global?: boolean, imports?: DynamicModule['imports'] }
  ): DynamicModule {
    return {
      module: QuaysideModule,
      global: context.global ?? true,
      imports: context.imports ?? [],
      providers: [
        optionsProvider,
        { provide: QUAYSIDE_IDEMPOTENCY, useFactory: (resolved: QuaysideModuleOptions) => new Idempotency(resolved), inject: [QUAYSIDE_MODULE_OPTIONS] },
        IdempotencyInterceptor
      ],
      exports: [QUAYSIDE_IDEMPOTENCY, QUAYSIDE_MODULE_OPTIONS, IdempotencyInterceptor]
    }
  }
}
