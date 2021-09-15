import { cac } from 'cac'

interface GlobalCLIOptions {
  m?: string
  mode?: string
}

const cli = cac('mf')

cli.option('-m, --mode <mode>', `[string] set env mode`)

cli.command('serve').action(
  async (options: GlobalCLIOptions) => {
    const { serve } = await import('./serve')
    await serve(options.mode)
  }
)

cli.command('build').action(
  async (options: GlobalCLIOptions) => {
    const { build } = await import('./build')
    await build(options.mode)
  }
)

cli.help()
cli.version(VERSION)
cli.parse()
