import { ROUTES_PACKAGE_NAME } from 'src/utils'

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

  ic.routes = {
    v2: {
      glob: [['packages/v2/*/src/pages/**/*.vue']],
      base: '/v2',
      depth: 1,
      extends: [
        {
          id: 'packages/v2/container/src/pages/layout.vue',
          path: '/v2',
          depth: 0
        }
      ]
    },
    v3: {
      glob: [['packages/v3/*/src/pages/**/*.vue']],
      base: '/v3',
      depth: 1,
      extends: [
        {
          id: 'packages/v3/container/src/pages/layout.vue',
          path: '/v3',
          depth: 0
        }
      ]
    }
  }

  const rmn2pm: Record<string, string[]> = {}
  rmn2pm[`${ROUTES_PACKAGE_NAME}/v2`] = [
    'packages/v2/container/src/pages/layout.vue',
    'packages/v2/purchase/src/pages/xx/index.vue',
    'packages/v2/purchase/src/pages/xx/detail.vue',
    'packages/v2/purchase/src/pages/yy/index.vue',
    'packages/v2/purchase/src/pages/yy/detail.vue'
  ]
  rmn2pm[`${ROUTES_PACKAGE_NAME}/v3`] = [
    'packages/v3/container/src/pages/layout.vue',
    'packages/v3/purchase/src/pages/xx/index.vue',
    'packages/v3/purchase/src/pages/xx/detail.vue',
    'packages/v3/purchase/src/pages/yy/index.vue',
    'packages/v3/purchase/src/pages/yy/detail.vue'
  ]

  jest.doMock(
    'src/utils',
    () => {
      return {
        __esModule: true,
        ...jest.requireActual('src/utils'),
        getRoutesMoudleNameToPagesMap: () => rmn2pm,
        getLocalModuleName: (path: string) => {
          return path.replace(/.+?\/(.+?)\/(.+?)\/src(.+)/, ic.scope + '/' + '$1-$2$3')
        }
      }
    }
  )

  it('should works correctly with serve', async () => {
    jest.doMock('src/build', () => ({ __esModule: true, building: false }))
    const { resolveConfig } = await import('src/utils')
    await resolveConfig(ic)
    const { routes } = await import('src/plugins')
    // @ts-ignore
    expect(await routes().load(`${ROUTES_PACKAGE_NAME}/v2`)).toMatchSnapshot()
    // @ts-ignore
    expect(await routes().load(`${ROUTES_PACKAGE_NAME}/v3`)).toMatchSnapshot()
  })

  it('should works correctly with build', async () => {
    jest.doMock('src/build', () => ({ __esModule: true, building: true }))
    const { resolveConfig } = await import('src/utils')
    await resolveConfig(ic)
    const { routes } = await import('src/plugins')
    // @ts-ignore
    expect(await routes().load(`${ROUTES_PACKAGE_NAME}/v2`)).toMatchSnapshot()
    // @ts-ignore
    expect(await routes().load(`${ROUTES_PACKAGE_NAME}/v3`)).toMatchSnapshot()
  })
})
