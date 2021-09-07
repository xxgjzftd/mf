import { isAbsolute, resolve } from 'path'
import { writeFile, rm } from 'fs/promises'
import { argv, exit, stdout } from 'process'
import { createRequire } from 'module'

import vite from 'vite'
import execa from 'execa'
import axios from 'axios'
import MagicString from 'magic-string'
import { init, parse } from 'es-module-lexer'

import {
  PACKAGE_JSON,
  config as mc,
  require,
  cached,
  isPkg,
  isPage,
  isLocalModule,
  isVendorModule,
  getSrcPathes,
  getVendor,
  getLocalModuleName,
  getLocalModulePath,
  getAlias,
  getExternal,
  getVersionedVendor,
  getUnversionedVendor,
  getPkgPathFromLmn,
  getPkgInfo,
  getRoutesMoudleNames
} from '@utils'
import { entry, routes } from '@plugins'
import * as utils from '@utils'

import type { OutputChunk } from 'rollup'
import type { Plugin, UserConfig } from 'vite'
import type { PackageJson } from 'type-fest'

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
  version?: string
}
interface Source {
  status: 'A' | 'M' | 'D'
  path: string
}
interface DepInfo {
  dependencies: string[]
  dependents: string[]
}

process.on(
  'uncaughtException',
  (error) => {
    console.log(error)
  }
)

let building = false

const build = async () => {
  building = true
  let meta: Meta
  const mode = argv[2]

  const config = await vite.resolveConfig({ mode }, 'build')

  const SEP = '$mf'
  const BASE = config.base
  const DIST = config.build.outDir
  const ASSETS = config.build.assetsDir
  const ROUTES = 'routes'
  const VENDOR = 'vendor'

  const isLocal = BASE === '/'
  try {
    if (isLocal) {
      meta = require(resolve(DIST, `meta.json`))
    } else {
      meta = await axios.get(`${BASE}meta.json`).then((res) => res.data)
    }
  } catch (error) {
    meta = { modules: {} }
  }
  // meta.json maybe empty
  meta.modules = meta.modules || {}

  let sources: Source[] = []
  if (meta.hash && meta.version === require('@mf/node/package.json').version) {
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
  await execa('yarn').stdout?.pipe(stdout)
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

  const versionedVendorToPkgJsonPathMap: Record<string, string> = {}
  const getVendorPkgJsonPath = (vendor: string, importer: string) => {
    const parent = isLocalModule(importer) ? getLocalModulePath(importer) : versionedVendorToPkgJsonPathMap[importer]
    let path = mc.rvpjp && mc.rvpjp(vendor, importer, parent, utils)
    if (!path) {
      const require = createRequire(parent)
      try {
        path = require.resolve(`${vendor}/${PACKAGE_JSON}`)
      } catch (error) {
        path = vite.normalizePath(require.resolve(vendor)).replace(new RegExp(`(?<=/${vendor}/).+`), PACKAGE_JSON)
      }
    }
    versionedVendorToPkgJsonPathMap[getVersionedVendor(vendor, require(path).version)] = path
    return path
  }

  const getVendorPkgInfo = (vendor: string, importer: string): PackageJson => {
    return require(getVendorPkgJsonPath(vendor, importer))
  }

  const getAllDepsOfVendor = (vendor: string, vendors: Set<string>, deps = new Set<string>()) => {
    const { dependencies } = getVersionedVendorPkgInfo(vendor)
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

  interface DepsTree {
    [vv: string]: DepsTree
  }

  const versionedVendorToDepsTreeMap: Record<string, DepsTree> = {}
  const getDepsTree = (vendors: string[], importer: string) => {
    const dt: DepsTree = {}
    vendors.forEach(
      (vendor) => {
        const { version, dependencies = {}, peerDependencies = {} } = getVendorPkgInfo(vendor, importer)
        const vv = getVersionedVendor(vendor, version!)
        dt[vv] =
          versionedVendorToDepsTreeMap[vv] ||
          (versionedVendorToDepsTreeMap[vv] = getDepsTree(
            Object.keys(Object.assign({}, dependencies, peerDependencies)),
            vv
          ))
      }
    )
    return dt
  }

  const vendorToRefCountMap: Record<string, number> = {}
  const vendorToDepInfoMap: Record<string, DepInfo> = {}
  const versionedVendorToImporterMap: Record<string, string> = {}

  const getVersionedVendorToBindingsMap = (isPre = false) => {
    const versionedVendorToBindingsSetMap: Record<string, Set<string>> = {}
    Object.keys(meta.modules).forEach(
      (mn) => {
        if (isPre || isLocalModule(mn)) {
          const { imports } = meta.modules[mn]
          if (imports) {
            Object.keys(imports).forEach(
              (imported) => {
                if (isVendorModule(imported)) {
                  let vv = getVendor(imported)
                  let prefix = imported + '/'
                  const bindings = (versionedVendorToBindingsSetMap[vv] =
                    versionedVendorToBindingsSetMap[vv] || new Set())
                  isPre || (versionedVendorToImporterMap[vv] = mn)
                  imports[imported].length
                    ? imports[imported].forEach(
                        (binding) => bindings.add((imported.length > vv.length ? prefix : '') + binding)
                      )
                    : bindings.add(prefix)
                }
              }
            )
          }
        }
      }
    )
    let vvs = new Set(Object.keys(versionedVendorToBindingsSetMap))
    if (!isPre) {
      const dt: DepsTree = {}
      vvs.forEach((vv) => Object.assign(dt, getDepsTree([getUnversionedVendor(vv)], versionedVendorToImporterMap[vv])))

      Object.keys(vendorToRefCountMap).forEach(
        (vendor) => {
          if (vendorToRefCountMap[vendor] > 1) {
            vvs.add(vendor)
          }
        }
      )
      vvs.forEach(
        (vendor) => {
          const info = (vendorToDepInfoMap[vendor] = vendorToDepInfoMap[vendor] || { dependencies: [], dependents: [] })
          const { peerDependencies, dependencies } = getVersionedVendorPkgInfo(vendor)
          if (peerDependencies) {
            info.dependencies = Object.keys(peerDependencies)
          }
          if (dependencies) {
            Object.keys(dependencies).forEach((dep) => vvs.has(dep) && info.dependencies.push(dep))
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
    const versionedVendorToBindingsMap: Record<string, string[]> = {}
    vvs.forEach(
      (vendor) => {
        if (versionedVendorToBindingsSetMap[vendor]) {
          versionedVendorToBindingsMap[vendor] = Array.from(versionedVendorToBindingsSetMap[vendor])
          versionedVendorToBindingsMap[vendor].sort()
        } else {
          versionedVendorToBindingsMap[vendor] = []
        }
      }
    )
    return versionedVendorToBindingsMap
  }

  const pvv2bm = getVersionedVendorToBindingsMap(true)

  const plugins = {
    meta (mn: string): Plugin {
      return {
        name: 'mf-meta',
        async renderChunk (code, chunk) {
          const { importedBindings } = chunk
          const pending: [string, string][] = []
          Object.keys(importedBindings).forEach(
            (imported) => {
              if (isVendorModule(imported)) {
                let vendor = getVendor(imported)
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
              if (isVendorModule(imported)) {
                const bindings = importedBindings[imported]
                Reflect.deleteProperty(importedBindings, imported)
                const vendor = getVendor(imported)
                importedBindings[
                  getVersionedVendor(vendor, getVendorPkgInfo(vendor, mn).version!) + imported.slice(vendor.length)
                ] = bindings
              }
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
        const preBindings = pvv2bm[mn]
        if (info.dependents) {
          await Promise.all(info.dependents.map((dep) => builder.vendor(dep)))
          const curBindingsSet = new Set(cvv2bm[mn])
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
          cvv2bm[mn] = Array.from(curBindingsSet).sort()
        }
        const curBindings = cvv2bm[mn]
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
                      curBindings.forEach(
                        (binding) => (binding.includes('/') ? subs.push(binding) : names.push(binding))
                      )
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
        const dc: UserConfig = {
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
          plugins: [
            {
              name: 'mf-lib',
              async resolveId (source, importer, options) {
                if (!source.startsWith('.') && !isAbsolute(source)) {
                  throw new Error(
                    `'${source}' is imported by ${importer || getLocalModulePath(lmn)},` +
                      `but it isn't declared in the dependencies field of the ` +
                      resolve(getPkgPathFromLmn(lmn), PACKAGE_JSON)
                  )
                }
                if (!isPkg(lmn)) {
                  const resolution = await this.resolve(source, importer, Object.assign({ skipSelf: true }, options))
                  const info = getModuleInfo(lmn)
                }
                return null
              }
            },
            plugins.meta(lmn)
          ]
        }
        const uc = mc.vite && mc.vite(lmn, utils)
        return vite.build(uc ? vite.mergeConfig(dc, uc) : dc)
      }
    ),
    routes: cached(
      async (rmn) => {
        const input = resolve(ROUTES)
        return vite.build(
          {
            mode,
            publicDir: false,
            build: {
              rollupOptions: {
                input,
                output: {
                  entryFileNames: `${ASSETS}/${rmn}.[hash].js`,
                  chunkFileNames: `${ASSETS}/${rmn}.[hash].js`,
                  assetFileNames: `${ASSETS}/${rmn}.[hash][extname]`,
                  format: 'es'
                },
                preserveEntrySignatures: 'allow-extension'
              }
            },
            plugins: [
              {
                name: 'mf-routes-build',
                resolveId (source) {
                  if (source === input) {
                    return rmn
                  }
                }
              },
              routes(),
              plugins.meta(rmn)
            ]
          }
        )
      }
    ),
    async entry () {
      return vite.build(
        {
          mode,
          plugins: [
            {
              name: 'mf-inject-meta',
              transformIndexHtml (html) {
                let importmap: { imports: Record<string, string> } = { imports: {} }
                const imports = importmap.imports
                Object.keys(meta.modules).forEach((mn) => (imports[mn] = BASE + meta.modules[mn].js))
                return {
                  html: html.replace(/\<script(.+)type=['"]module['"]/g, '<script$1type="module-shim"'),
                  tags: [
                    {
                      tag: 'script',
                      attrs: {
                        type: 'importmap-shim'
                      },
                      children: JSON.stringify(importmap)
                    },
                    {
                      tag: 'script',
                      children:
                        `window.mf = window.mf || {};` +
                        `window.mf.base = '${BASE}';` +
                        `window.mf.modules = ${JSON.stringify(meta.modules)}`
                    }
                  ]
                }
              }
            },
            entry()
          ]
        }
      )
    }
  }

  await Promise.all(
    sources.map(
      async ({ path, status }: Source) => {
        const pi = getPkgInfo(path)
        const { main } = pi
        const lmn = getLocalModuleName(path)
        if (status !== 'A' && !main) {
          remove(lmn)
        }
        if (isPage(path)) {
          return Promise.all(
            [builder.lib(lmn), ...(status === 'A' ? getRoutesMoudleNames(path).map(builder.routes) : [])]
          )
        }
        return builder.lib(lmn)
      }
    )
  )

  const cvv2bm = getVersionedVendorToBindingsMap()
  Object.keys(pvv2bm).forEach(
    (vendor) => {
      if (!(vendor in cvv2bm)) {
        remove(vendor)
      }
    }
  )

  await Promise.all(
    Object.keys(cvv2bm)
      .filter((vendor) => !vendorToDepInfoMap[vendor].dependencies.length)
      .map((vendor) => builder.vendor(vendor))
  )

  await Promise.all([writeFile(resolve(DIST, `meta.json`), JSON.stringify(meta)), builder.entry()])
}

export { building, build }
