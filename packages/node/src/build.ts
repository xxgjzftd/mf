import { resolve } from 'path'
import { readFile, writeFile, rm } from 'fs/promises'
import { createRequire } from 'module'
import { argv, exit } from 'process'

import vite from 'vite'
import execa from 'execa'
import axios from 'axios'
import fg from 'fast-glob'
import MagicString from 'magic-string'
import { init, parse } from 'es-module-lexer'

import { cached, isLocalModule, isRoutesModule, getLocalModuleName, getVendorPkgInfo } from './utils'

import type { OutputChunk } from 'rollup'
import type { Plugin } from 'vite'

interface MetaModuleInfo {
  js: string
  css?: string
  imports?: OutputChunk['importedBindings']
}

interface MetaModules {
  [mn: string]: MetaModuleInfo
}

interface Meta {
  modules: MetaModules
  hash?: string
}

let building = false
let meta: Meta
const mode = argv[2]
const require = createRequire(import.meta.url)

const config = await vite.resolveConfig({ mode }, 'build')

const BASE = config.base
const DIST = config.build.outDir
const SEP = '$mf'

const isLocal = BASE === '/'
try {
  if (isLocal) {
    meta = require(resolve(`${DIST}/meta.json`))
  } else {
    meta = await axios.get(`${BASE}meta.json`).then((res) => res.data)
  }
} catch (error) {
  meta = { modules: {} }
}
// meta.json maybe empty
meta.modules = meta.modules || {}

interface Source {
  status: 'A' | 'M' | 'D'
  path: string
}

let sources: Source[] = []
if (meta.hash) {
  const { stdout } = execa.sync('git', ['diff', meta.hash, 'HEAD', '--name-status'])
  sources = stdout
    .split('\n')
    .map(
      (info) => {
        const [status, path] = info.split('\t')
        return { status, path } as Source
      }
    )
    .filter(({ path }) => /packages\/.+?\/src\/.+/.test(path))
} else {
  // TODO: add support for resolving workspaces config from package.json and file extension config
  sources = fg.sync('packages/*/src/**/*.{ts,tsx,vue}').map(
    (path) => {
      return { status: 'A', path }
    }
  )
}
!sources.length && exit()
meta.hash = execa.sync('git', ['rev-parse', '--short', 'HEAD']).stdout

const remove = (mn: string) => {
  const info = meta.modules[mn]
  const removals = []
  if (info) {
    Reflect.deleteProperty(meta.modules, mn)
    removals.push(info.js)
    info.css && removals.push(info.css)
  }
  if (isLocal) {
    removals.forEach(
      (path) =>
        rm(
          resolve(DIST, path),
          {
            force: true,
            recursive: true
          }
        )
    )
  }
}

const getModuleInfo = cached((mn) => (meta.modules[mn] = meta.modules[mn] || {}))

const getAllDepsOfVendor = (vendor: string, vendors: Set<string>, deps = new Set<string>()) => {
  const { dependencies } = getVendorPkgInfo(vendor)
  if (dependencies) {
    Object.keys(dependencies).forEach(
      (dep) => {
        deps.add(dep)
        !vendors.has(dep) && getAllDepsOfVendor(dep, vendors, deps)
      }
    )
  }
  return deps
}

interface DepInfo {
  dependencies: string[]
  dependents: string[]
}
const vendorToRefCountMap: Record<string, number> = {}
const vendorToDepInfoMap: Record<string, DepInfo> = {}

const getVendorToBindingsMap = (isPre = false) => {
  const vendorToBindingsSetMap: Record<string, Set<string>> = {}
  Object.keys(meta.modules).forEach(
    (mn) => {
      if (isPre || isLocalModule(mn)) {
        const { imports } = meta.modules[mn]
        if (imports) {
          Object.keys(imports).forEach(
            (imported) => {
              if (!isLocalModule(imported) && !isRoutesModule(imported)) {
                const index = imported.indexOf('/', imported[0] === '@' ? imported.indexOf('/') + 1 : 0)
                let vendor = ~index ? imported.slice(0, index) : imported
                let prefix = imported + '/'
                const bindings = (vendorToBindingsSetMap[vendor] = vendorToBindingsSetMap[vendor] || new Set())
                imports[imported].length
                  ? imports[imported].forEach((binding) => bindings.add((~index ? prefix : '') + binding))
                  : bindings.add(prefix)
              }
            }
          )
        }
      }
    }
  )
  let vendors = new Set(Object.keys(vendorToBindingsSetMap))
  if (!isPre) {
    vendors.forEach(
      (vendor) => {
        getAllDepsOfVendor(vendor, vendors).forEach(
          (dep) => {
            vendorToRefCountMap[dep] = (vendorToRefCountMap[dep] || 0) + 1
          }
        )
      }
    )
    Object.keys(vendorToRefCountMap).forEach(
      (vendor) => {
        if (vendorToRefCountMap[vendor] > 1) {
          vendors.add(vendor)
        }
      }
    )
    vendors.forEach(
      (vendor) => {
        const info = (vendorToDepInfoMap[vendor] = vendorToDepInfoMap[vendor] || { dependencies: [], dependents: [] })
        const { peerDependencies, dependencies } = getVendorPkgInfo(vendor)
        if (peerDependencies) {
          info.dependencies = Object.keys(peerDependencies)
        }
        if (dependencies) {
          Object.keys(dependencies).forEach((dep) => vendors.has(dep) && info.dependencies.push(dep))
        }
        info.dependencies.forEach(
          (dep) => {
            const depInfo = (vendorToDepInfoMap[dep] = vendorToDepInfoMap[dep] || {})
            depInfo.dependents = depInfo.dependents || []
            depInfo.dependents.push(vendor)
          }
        )
      }
    )
  }
  const vendorToBindingsMap: Record<string, string[]> = {}
  vendors.forEach(
    (vendor) => {
      if (vendorToBindingsSetMap[vendor]) {
        vendorToBindingsMap[vendor] = Array.from(vendorToBindingsSetMap[vendor])
        vendorToBindingsMap[vendor].sort()
      } else {
        vendorToBindingsMap[vendor] = []
      }
    }
  )
  return vendorToBindingsMap
}

const preVendorToBindingsMap = getVendorToBindingsMap(true)

const plugins = {
  meta (mn: string): Plugin {
    return {
      name: 'mf-meta',
      async renderChunk (code, chunk) {
        const { importedBindings } = chunk
        const pending: [string, string][] = []
        Object.keys(importedBindings).forEach(
          (imported) => {
            if (!isLocalModule(imported) && !isRoutesModule(imported)) {
              let vendor = imported
              const segs = imported.split('/')
              if (imported[0] === '@') {
                if (segs.length > 2) {
                  vendor = segs[0] + '/' + segs[1]
                }
              } else {
                if (segs.length > 1) {
                  vendor = segs[0]
                }
              }
              if (imported.length > vendor.length) {
                pending.push([imported, vendor])
              }
            }
          }
        )
        if (pending.length) {
          await init
          const [imports] = parse(code)
          const ms = new MagicString(code)
          pending.forEach(
            ([imported, vendor]) => {
              imports.forEach(
                ({ n: mn, ss, se }) => {
                  if (mn === imported) {
                    const bindings = importedBindings[imported]
                    let content = ''
                    if (bindings.length) {
                      const bindingToNameMap: Record<string, string> = {}
                      const d = code
                        .slice(ss, se)
                        .replace(/\n/g, '')
                        .match(/(?<=^import).+?(?=from)/)![0]
                        .trim()
                      const m = d.match(/^{(.+)}$/)
                      if (m) {
                        m[1]
                          .split(',')
                          .map(
                            (s) =>
                              s
                                .trim()
                                .split(' as ')
                                .map((v) => v.trim())
                          )
                          .forEach(([binding, name]) => (bindingToNameMap[binding] = name || binding))
                      } else if (d[0] === '*') {
                        bindingToNameMap['*'] = d.split(' as ')[1].trim()
                      } else {
                        bindingToNameMap.default = d
                      }

                      content =
                        `import { ` +
                        bindings
                          .map(
                            (binding) =>
                              `${imported}/${binding}`.replace(/\W/g, SEP) + ` as ${bindingToNameMap[binding]}`
                          )
                          .join(',') +
                        `} from "${vendor}"`
                    } else {
                      content = `import "${vendor}"`
                    }
                    ms.overwrite(ss, se, content)
                  }
                }
              )
            }
          )
          return {
            code: ms.toString(),
            map: ms.generateMap({ hires: true })
          }
        }
        return null
      },
      generateBundle (options, bundle) {
        const info = getModuleInfo(mn)
        const fileNames = Object.keys(bundle)
        const js = fileNames.find((fileName) => (bundle[fileName] as OutputChunk).isEntry)!
        const css = fileNames.find((fileName) => fileName.endsWith('.css'))
        info.js = js
        css && (info.css = css)
        const { importedBindings } = bundle[js] as OutputChunk
        info.imports = importedBindings
        Object.keys(importedBindings).forEach(
          (imported) => {
            if (
              isLocalModule(imported) &&
              !meta.modules[imported] &&
              !sources.find((source) => getLocalModuleName(source.path) === imported)
            ) {
              throw new Error(`'${mn}'中引用的'${imported}'模块不存在。`)
            }
          }
        )
      }
    }
  }
}

export { building, build }
