import { dts } from 'rollup-plugin-dts'
import typescript from '@rollup/plugin-typescript'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

// A subpath entry that uses core RUNTIME (the storage adapters throw the
// core error classes) must import the shipped core bundle, never carry a
// private copy: instanceof checks on the error taxonomy have to hold across
// entry points. Types are not affected; the dts bundles keep inlining,
// interfaces have no identity.
const CORE_SPECIFIER = '../index'
const corePaths = (format) => (id) =>
  id.endsWith('/src/index') || id === CORE_SPECIFIER ? (format === 'es' ? './index.mjs' : './index.cjs') : id

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
    external: core ? (id) => external(id) || id === CORE_SPECIFIER : external
  },
  {
    input,
    // The .d.cts is a byte-identical copy: the declarations contain nothing
    // module-kind-sensitive, and emitting both here keeps the build script a
    // plain `rollup -c` however many entry points exist.
    output: [
      { file: `dist/${name}.d.ts`, format: 'es' },
      { file: `dist/${name}.d.cts`, format: 'es' }
    ],
    plugins: [dts()],
    external
  }
]

export default [
  ...entry('src/index.ts', 'index'),
  ...entry('src/memory/index.ts', 'memory', { core: true }),
  ...entry('src/redis/index.ts', 'redis', { core: true }),
  ...entry('src/postgres/index.ts', 'postgres', { core: true }),
  ...entry('src/mysql/index.ts', 'mysql', { core: true }),
  ...entry('src/express/index.ts', 'express', { core: true }),
  ...entry('src/fastify/index.ts', 'fastify', { core: true }),
  ...entry('src/hono/index.ts', 'hono', { core: true }),
  ...entry('src/nestjs/index.ts', 'nestjs', { core: true })
]
