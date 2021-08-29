import { createRequire } from 'module'

import esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const pi = require('./package.json')

esbuild.build(
  {
    bundle: true,
    entryPoints: ['src/index.ts'],
    external: Object.keys(pi.dependencies),
    format: 'esm',
    outdir: 'dist',
    platform: 'node',
    target: 'node14.17.0',
    write: true,
    entryNames: '[dir]/[name]'
  }
)
