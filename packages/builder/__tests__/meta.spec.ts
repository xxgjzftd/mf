import type { Meta, MetaModuleInfo, PluginContext, Source } from 'src/build'
import type { MFConfig } from 'src/utils'

const ic: MFConfig = {
  scope: '@xx',
  extensions: ['vue', 'ts', 'js'],
  apps: []
}

beforeEach(
  () => {
    jest.resetModules()
  }
)

it('should works correctly', async () => {
  const { resolveConfig } = await import('src/utils')
  await resolveConfig(ic)
  const { SEP, plugins } = await import('src/build')
  const lmn = '@xx/container'
  const mi: MetaModuleInfo = { js: '', imports: {} }
  const meta: Meta = { modules: {} }
  meta.modules[lmn] = mi
  const importerToVendorToVersionedVendorMapMap: PluginContext['importerToVendorToVersionedVendorMapMap'] = {}
  importerToVendorToVersionedVendorMapMap[lmn] = { vue: 'vue@3.0.0', lodash: 'lodash@4.0.0', echarts: 'echarts@5.0.0' }
  const sources: Source[] = []
  const pc: Partial<PluginContext> = {
    getModuleInfo: (mn) => meta.modules[mn],
    shouldVersioned: (vendor) => vendor === 'vue',
    importerToVendorToVersionedVendorMapMap,
    meta,
    sources
  }
  const importedBindings = { vue: ['reactive'], lodash: ['join'], 'echarts/renderers': ['CanvasRenderer'] }
  // @ts-ignore
  const { code } = await plugins.meta(lmn, pc).renderChunk!(
    `import { reactive, ref } from 'vue'\n` +
      `import { join } from 'lodash'\n` +
      `import { CanvasRenderer } from 'echarts/renderers'\n`,
    { importedBindings }
  )

  expect(code).toMatch(`import { reactive, ref } from "vue@3.0.0"\n`)
  expect(code).toMatch(`import { join } from 'lodash'\n`)
  expect(code).toMatch(`import { echarts${SEP}renderers${SEP}CanvasRenderer as CanvasRenderer } from "echarts"\n`)

  const js = 'assets/index.e808bb33.js'
  const css = 'assets/index.39714e9a.css'
  const bundle: any = {}
  bundle[js] = { type: 'chunk', isEntry: true, importedBindings }
  bundle[css] = { type: 'asset' }
  // @ts-ignore
  plugins.meta(lmn, pc).generateBundle({}, bundle)
  expect(mi.js).toBe(js)
  expect(mi.css).toBe(css)
  expect(mi.imports).toEqual(
    { 'vue@3.0.0': ['reactive'], 'lodash@4.0.0': ['join'], 'echarts@5.0.0': ['echarts/renderers/CanvasRenderer'] }
  )
})
