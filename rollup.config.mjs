import { dts } from 'rollup-plugin-dts'
import typescript from '@rollup/plugin-typescript'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

// A subpath entry that uses the core (the storage adapters throw the core
// error classes; the HTTP adapters take an Idempotency instance) must
// import the shipped core bundle, never carry a private copy: instanceof
// checks on the error taxonomy have to hold across entry points at
// runtime, and the SAME rule holds for the declaration bundles - a class
// with private members is nominal in TypeScript, so an inlined `declare
// class Idempotency` in express.d.ts is a different type from the one in
// index.d.ts and a consumer passing `new Idempotency(...)` to
// ExpressMiddleware() fails to type-check. Interfaces have no identity and
// may inline freely; classes may not.
//
// '../storage' is on the list as a backstop, not a convention: adapters are
// written against '../index', but a deep import that slipped through would
// otherwise inline src/storage - whose decoder throws StorageCorruptError -
// as a private copy per bundle, and every name it exports is re-exported by
// the core entry, so mapping it there is always sound.
const CORE_SPECIFIERS = ['../index', '../storage']
const isCoreId = (id) => CORE_SPECIFIERS.includes(id) || id.endsWith('/src/index') || id.endsWith('/src/storage')
const corePaths = (format) => (id) =>
  isCoreId(id) ? (format === 'es' ? './index.mjs' : './index.cjs') : id
// The declaration bundles point at the core declarations the way TypeScript
// resolves them: `./index.js` is looked up as index.d.ts (the ESM entry) and
// `./index.cjs` as index.d.cts, so each module kind lands on its own copy.
const coreTypePaths = (kind) => (id) =>
  isCoreId(id) ? (kind === 'cts' ? './index.cjs' : './index.js') : id

// One pair of configs per public entry point. Each subpath bundles its own
// tree; `core: true` is the exception above: the code bundle then imports
// the core entry instead of duplicating it.
const entry = (input, name, { core = false } = {}) => [
  {
    input,
    output: [
      { file: `dist/${name}.cjs`, format: 'cjs', exports: 'named', ...(core && { paths: corePaths('cjs') }) },
      { file: `dist/${name}.mjs`, format: 'es', exports: 'named', ...(core && { paths: corePaths('es') }) }
    ],
    plugins: [typescript({ include: ['src/**/*.ts'] })],
    external: core ? (id) => external(id) || isCoreId(id) : external
  },
  {
    input,
    // The two declaration files differ only in how they name the core
    // declarations they import (see coreTypePaths); emitting both here keeps
    // the build script a plain `rollup -c` however many entry points exist.
    output: [
      { file: `dist/${name}.d.ts`, format: 'es', ...(core && { paths: coreTypePaths('ts') }) },
      { file: `dist/${name}.d.cts`, format: 'es', ...(core && { paths: coreTypePaths('cts') }) }
    ],
    plugins: [dts()],
    external: core ? (id) => external(id) || isCoreId(id) : external
  }
]

export default [
  ...entry('src/index.ts', 'index'),
  ...entry('src/memory/index.ts', 'memory', { core: true }),
  ...entry('src/redis/index.ts', 'redis', { core: true }),
  ...entry('src/postgres/index.ts', 'postgres', { core: true }),
  ...entry('src/mysql/index.ts', 'mysql', { core: true }),
  ...entry('src/dynamodb/index.ts', 'dynamodb', { core: true }),
  ...entry('src/express/index.ts', 'express', { core: true }),
  ...entry('src/fastify/index.ts', 'fastify', { core: true }),
  ...entry('src/hono/index.ts', 'hono', { core: true }),
  ...entry('src/nestjs/index.ts', 'nestjs', { core: true }),
  ...entry('src/prometheus/index.ts', 'prometheus'),
  ...entry('src/otel/index.ts', 'otel')
]
