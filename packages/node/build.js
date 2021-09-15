import { createRequire } from 'module'

import esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const pi = require('./package.json')

esbuild.build(
  {
    bundle: true,
    splitting: true,
    define: { VERSION: JSON.stringify(pi.version) },
    entryPoints: ['src/index.ts', 'src/cli.ts'],
    external: Object.keys(pi.dependencies),
    format: 'esm',
    outdir: 'dist',
    platform: 'node',
    target: 'node14.17.0',
    write: true,
    entryNames: '[dir]/[name]'
  }
)
