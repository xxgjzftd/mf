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

import {
  cached,
  isLocalModule,
  isRoutesModule,
  getSrcPathes,
  getLocalModuleName,
  getLocalModulePath,
  getVendorPkgInfo,
  getAlias,
  getExternal
} from '@utils'

import type { OutputChunk } from 'rollup'
import type { Plugin } from 'vite'

interface MetaModuleInfo {
  js: string
  css?: string
  imports: OutputChunk['importedBindings']
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

const SEP = '$mf'
const BASE = config.base
const DIST = config.build.outDir
const ASSETS = config.build.assetsDir
const VENDOR = 'vendor'

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
    .filter(({ path }) => getSrcPathes().includes(path))
} else {
  sources = getSrcPathes().map(
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
      generateBundle (_, bundle) {
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
              throw new Error(
                `'${imported}' is imported by '${mn}',` +
                  `but it doesn't exist.\n` +
                  `please check if ${getLocalModulePath(imported)} exists.`
              )
            }
          }
        )
      }
    }
  }
}

const builder = {
  vendor: cached(
    async (mn) => {
      const info = vendorToDepInfoMap[mn]
      const preBindings = preVendorToBindingsMap[mn]
      if (info.dependents) {
        await Promise.all(info.dependents.map((dep) => builder.vendor(dep)))
        const curBindingsSet = new Set(curVendorToBindingsMap[mn])
        info.dependents.forEach(
          (dep) => {
            const imports = meta.modules[dep].imports
            Object.keys(imports).forEach(
              (imported) => {
                if (imported.startsWith(mn)) {
                  let prefix = imported.length > mn.length ? imported + '/' : ''
                  imports[imported]
                    ? imports[imported].forEach((binding) => curBindingsSet.add(prefix + binding))
                    : curBindingsSet.add(imported + '/')
                }
              }
            )
          }
        )
        curVendorToBindingsMap[mn] = Array.from(curBindingsSet).sort()
      }
      const curBindings = curVendorToBindingsMap[mn]
      if (!preBindings || preBindings.toString() !== curBindings.toString()) {
        remove(mn)
        const input = resolve(VENDOR)
        return vite.build(
          {
            mode,
            publicDir: false,
            build: {
              rollupOptions: {
                input,
                output: {
                  entryFileNames: `${ASSETS}/${mn}.[hash].js`,
                  chunkFileNames: `${ASSETS}/${mn}.[hash].js`,
                  assetFileNames: `${ASSETS}/${mn}.[hash][extname]`,
                  format: 'es',
                  manualChunks: {}
                },
                preserveEntrySignatures: 'allow-extension',
                external: info.dependencies.map((dep) => new RegExp('^' + dep + '(/.+)?$'))
              }
            },
            plugins: [
              {
                name: 'mf-vendor',
                enforce: 'pre',
                resolveId (source) {
                  if (source === input) {
                    return VENDOR
                  }
                },
                load (id) {
                  if (id === VENDOR) {
                    let names: string[] = []
                    let subs: string[] = []
                    curBindings.forEach((binding) => (binding.includes('/') ? subs.push(binding) : names.push(binding)))
                    return (
                      (names.length
                        ? names.includes('*')
                          ? `export * from "${mn}";`
                          : `export { ${names.toString()} } from "${mn}";`
                        : '') +
                      subs
                        .map(
                          (sub) => {
                            const index = sub.lastIndexOf('/')
                            const path = sub.slice(0, index)
                            const binding = sub.slice(index + 1)
                            return binding
                              ? binding === '*'
                                ? `export * as ${sub.replace(/\W/g, SEP)} from "${path}";`
                                : `export { ${binding} as ` + `${sub.replace(/\W/g, SEP)} } from "${path}";`
                              : `import "${path}";`
                          }
                        )
                        .join('\n')
                    )
                  }
                }
              },
              plugins.meta(mn)
            ]
          }
        )
      }
    }
  ),
  // utils components pages containers
  lib: cached(
    async (lmn) => {
      return vite.build(
        {
          mode,
          publicDir: false,
          resolve: {
            // @ts-ignore because @rollup/plugin-alias' type doesn't allow function
            // replacement, but its implementation does work with function values.
            alias: getAlias(lmn)
          },
          build: {
            rollupOptions: {
              input: resolve(getLocalModulePath(lmn)),
              output: {
                entryFileNames: `${ASSETS}/[name].[hash].js`,
                chunkFileNames: `${ASSETS}/[name].[hash].js`,
                assetFileNames: `${ASSETS}/[name].[hash][extname]`,
                format: 'es'
              },
              preserveEntrySignatures: 'allow-extension',
              external: getExternal(lmn)
            }
          },
          plugins: [plugins.meta(lmn)]
        }
      )
    }
  ),
  routes: cached((rmn) => {})
}

const build = async ({ path, status }) => {
  const pkg = getPkgInfo(path)
  const { name, main } = pkg
  const { type } = getPkgConfig(path)
  if (status !== 'A') {
    remove(getLocalModuleName(path))
  }
  if (isRoute(path)) {
    return Promise.all([builder.lib(path), status === 'A' && builder.container()])
  }
  switch (type) {
    case PAGES:
      return builder.lib(path)
    case COMPONENTS:
    case UTILS:
      return builder.lib(path.replace(/(?<=(.+?\/){2}).+/, main))
    case CONTAINER:
      return builder.container()
    default:
      throw new Error(`${name} type 未指定`)
  }
}

await Promise.all(sources.map(build))

const curVendorToBindingsMap = getVendorToBindingsMap()
Object.keys(preVendorToBindingsMap).forEach(
  (vendor) => {
    if (!(vendor in curVendorToBindingsMap)) {
      remove(vendor)
    }
  }
)

export { building, build }
