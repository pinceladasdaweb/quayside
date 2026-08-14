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
import {
  ConcurrentExecutionError,
  Idempotency,
  IdempotencyKeyReuseError,
  QuaysideError,
  WaitTimeoutError
} from '../index'
import type { Duration, IdempotencyOptions } from '../index'

/** Injection token for the Idempotency instance built by QuaysideModule. */
export const QUAYSIDE_IDEMPOTENCY = 'QUAYSIDE_IDEMPOTENCY'
/** Injection token for the module options (storage, TTLs, header). */
export const QUAYSIDE_MODULE_OPTIONS = 'QUAYSIDE_MODULE_OPTIONS'

// A symbol cannot collide with foreign metadata and needs no name: the
// decorator and the interceptor share this reference.
const IDEMPOTENT_METADATA = Symbol('quayside idempotent')

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

// An empty-string header falls out at the caller's key check, together with
// the absent-key case.
function headerValue (value: unknown): string | undefined {
  if (Array.isArray(value)) return headerValue(value[0])
  return typeof value === 'string' ? value : undefined
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

    try {
      const outcome = await this.instanceFor(options.ttl).executeWithMetadata(
        { key, payload },
        async () => lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)))
      )
      if (outcome.replayed) setResponseHeader(response, 'idempotency-replayed', 'true')
      return outcome.value
    } catch (error) {
      throw this.mapError(error, response)
    }
  }

  // Routes with a ttl override are the exception, so the derived instance
  // is built on demand; it shares the base storage.
  private instanceFor (ttl: Duration | undefined): Idempotency {
    return ttl === undefined
      ? this.idempotency
      : new Idempotency({ ...this.options, resultTtl: ttl })
  }

  private mapError (error: unknown, response: unknown): unknown {
    if (error instanceof ConcurrentExecutionError || error instanceof WaitTimeoutError) {
      setResponseHeader(response, 'retry-after', '1')
      return new HttpException(
        { statusCode: 409, error: error.code, message: 'another request with this idempotency key is still in progress' },
        409
      )
    }
    if (error instanceof IdempotencyKeyReuseError) {
      return new HttpException(
        { statusCode: 422, error: error.code, message: 'this idempotency key was already used with a different payload' },
        422
      )
    }
    if (error instanceof QuaysideError) {
      const status = error.code === 'IDEMPOTENCY_STORAGE_UNAVAILABLE' ? 503 : 500
      return new HttpException({ statusCode: status, error: error.code, message: error.message }, status)
    }
    return error
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
