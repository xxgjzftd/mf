import type { MFConfig } from 'src/utils'

const ic: MFConfig = {
  scope: '@xx',
  extensions: ['vue', 'ts', 'js'],
  apps: []
}

describe('base', () => {
  beforeEach(
    () => {
      jest.resetModules()
    }
  )

  ic.apps = [
    {
      name: 'v2-container',
      predicate: (pathname) => pathname.startsWith('/v2')
    },
    {
      name: 'v3-container',
      predicate: (pathname) => pathname.startsWith('/v3')
    }
  ]

  const apn2lmpm: Record<string, string> = {}
  apn2lmpm[`${ic.scope}/v2-container`] = 'packages/v2/container/src/index.js'
  apn2lmpm[`${ic.scope}/v3-container`] = 'packages/v3/container/src/index.ts'

  jest.doMock(
    'src/utils',
    () => {
      return {
        __esModule: true,
        ...jest.requireActual('src/utils'),
        getApps: () => ic.apps,
        getLocalModulePath: (lmn: string) => apn2lmpm[lmn]
      }
    }
  )

  it('should works correctly with serve', async () => {
    jest.doMock('src/build', () => ({ __esModule: true, building: false }))
    const { resolveConfig } = await import('src/utils')
    await resolveConfig(ic)
    const { entry } = await import('src/plugins')
    // @ts-ignore
    expect(await entry().transformIndexHtml()).toMatchSnapshot()
  })

  it('should works correctly with build', async () => {
    jest.doMock('src/build', () => ({ __esModule: true, building: true }))
    const { resolveConfig } = await import('src/utils')
    await resolveConfig(ic)
    const { entry } = await import('src/plugins')
    // @ts-ignore
    expect(await entry().transformIndexHtml()).toMatchSnapshot()
  })
})
