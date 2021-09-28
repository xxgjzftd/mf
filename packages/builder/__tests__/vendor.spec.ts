import { resolveConfig } from 'src/utils'
import { SEP, VENDOR, plugins } from 'src/build'
import type { VendorPluginContext } from 'src/build'
import type { MFConfig } from 'src/utils'

const ic: MFConfig = {
  scope: '@xx',
  extensions: ['vue', 'ts', 'js'],
  apps: []
}

const vv = 'echarts@5.0.0'
const vpc: Partial<VendorPluginContext> = {
  vendor: 'echarts'
}

beforeAll(
  async () => {
    await resolveConfig(ic)
  }
)

test('plain bindings', async () => {
  vpc.curBindings = ['use', 'util']
  // @ts-ignore
  const code = await plugins.vendor(vv, vpc).load!(VENDOR)

  expect(code).toMatch(`export { use,util } from "echarts"`)
})

test('subpath bindings', async () => {
  vpc.curBindings = ['echarts/charts/BarChart', 'echarts/charts/PieChart']
  // @ts-ignore
  const code = await plugins.vendor(vv, vpc).load!(VENDOR)

  expect(code).toMatch(`export { BarChart as echarts${SEP}charts${SEP}BarChart } from "echarts/charts"`)
  expect(code).toMatch(`export { PieChart as echarts${SEP}charts${SEP}PieChart } from "echarts/charts"`)
})

test('polyfill', async () => {
  vpc.curBindings = ['moment/dist/locale/zh-cn/']
  // @ts-ignore
  const code = await plugins.vendor(vv, vpc).load!(VENDOR)

  expect(code).toMatch(`import "moment/dist/locale/zh-cn"`)
})

test('binding includes keyword "as"', async () => {
  vpc.curBindings = ['echarts/renderers/CanvasRenderer']
  // @ts-ignore
  const code = await plugins.vendor(vv, vpc).load!(VENDOR)

  expect(code).toMatch(
    `export { CanvasRenderer as echarts${SEP}renderers${SEP}CanvasRenderer } from "echarts/renderers"`
  )
})

test('mix', async () => {
  vpc.curBindings = [
    'use',
    'util',
    'echarts/charts/BarChart',
    'echarts/charts/PieChart',
    'moment/dist/locale/zh-cn/',
    'echarts/renderers/CanvasRenderer'
  ]
  // @ts-ignore
  const code = await plugins.vendor(vv, vpc).load!(VENDOR)

  expect(code).toMatch(`export { use,util } from "echarts"`)
  expect(code).toMatch(`export { BarChart as echarts${SEP}charts${SEP}BarChart } from "echarts/charts"`)
  expect(code).toMatch(`export { PieChart as echarts${SEP}charts${SEP}PieChart } from "echarts/charts"`)
  expect(code).toMatch(`import "moment/dist/locale/zh-cn"`)
  expect(code).toMatch(
    `export { CanvasRenderer as echarts${SEP}renderers${SEP}CanvasRenderer } from "echarts/renderers"`
  )
})
