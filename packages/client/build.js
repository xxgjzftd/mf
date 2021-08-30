import esbuild from 'esbuild'

esbuild.build(
  {
    bundle: true,
    entryPoints: ['src/index.ts'],
    format: 'iife',
    minify: false,
    outdir: 'dist',
    platform: 'browser',
    target: 'es2017',
    write: true,
    entryNames: '[dir]/[name]'
  }
)
