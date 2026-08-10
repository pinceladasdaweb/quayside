import typescript from '@rollup/plugin-typescript'
import { dts } from 'rollup-plugin-dts'

// A library build must never inline dependencies: everything that is not
// the library's own source (deps, node builtins) stays external.
const external = (id) => !id.startsWith('.') && !id.startsWith('/')

// One pair of configs per public entry point (storage and framework
// adapters will each add their own pair as they land).
const entry = (input, name) => [
  {
    input,
    output: [{ file: `dist/${name}.js`, format: 'es', exports: 'named' }],
    plugins: [typescript({ include: ['src/**/*.ts'] })],
    external
  },
  {
    input,
    output: [{ file: `dist/${name}.d.ts`, format: 'es' }],
    plugins: [dts()],
    external
  }
]

export default [
  ...entry('src/index.ts', 'index')
]
