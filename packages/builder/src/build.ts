import { isAbsolute, resolve } from 'path'
import { writeFile, rm } from 'fs/promises'
import { exit, stdout } from 'process'
import { createRequire } from 'module'

import vite from 'vite'
import execa from 'execa'
import axios from 'axios'
import MagicString from 'magic-string'
import { init, parse } from 'es-module-lexer'

import {
  PACKAGE_JSON,
  resolveConfig,
  rq,
  once,
  cached,
  isPage,
  isLocalModule,
  isVendorModule,
  isIndependentModule,
  getSrcPathes,
  getPkgName,
  getPkgNames,
  getNormalizedPath,
  getVendor,
  getLocalModuleName,
  getLocalModulePath,
  getAlias,
  getExternal,
  getVersionedVendor,
  getUnversionedVendor,
  getPkgJsonPath,
  getPkgPathFromPath,
  getPkgPathFromLmn,
  getRoutesMoudleNames
} from 'src/utils'
import { entry, routes } from 'src/plugins'
import * as utils from 'src/utils'

import type { OutputChunk } from 'rollup'
import type { Plugin, UserConfig } from 'vite'
import type { PackageJson } from 'type-fest'

export interface MetaModuleInfo {
  js: string
  css?: string
  sources?: string[]
  imports: Record<string, string[]>
}

interface MetaModules {
  [mn: string]: MetaModuleInfo
}

export interface Meta {
  modules: MetaModules
  hash?: string
  version?: string
}
export interface Source {
  status: 'A' | 'M' | 'D'
  path: string
}
interface DepInfo {
  dependencies: string[]
  dependents: string[]
}

const SEP = '$mf'
const ROUTES = 'routes'
const VENDOR = 'vendor'

let building = false

const getMeta = once(
  async (isLocal: boolean, BASE: string, DIST: string) => {
    let meta: Meta
    try {
      if (isLocal) {
        meta = rq(resolve(DIST, `meta.json`))
      } else {
        meta = await axios.get(`${BASE}meta.json`).then((res) => res.data)
      }
    } catch (error) {
      meta = { modules: {} }
    }
    // meta.json maybe empty
    meta.modules = meta.modules || {}
    return meta
  }
)

const getSources = once(
  (meta: Meta) => {
    let sources: Source[] = []
    if (meta.hash && meta.version === VERSION) {
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
    return sources
  }
)

export interface PluginContext {
  shouldVersioned(vendor: string): boolean
  versionedVendorToImportersMap: Record<string, string[]>
  importerToVendorToVersionedVendorMapMap: Record<string, Record<string, string>>
  getModuleInfo(mn: string): MetaModuleInfo
  getPkgJsonPathFromImporter(importer: string): string
  meta: Meta
  sources: Source[]
}

export interface VendorPluginContext extends PluginContext {
  input: string
  vendor: string
  curBindings: string[]
}

const plugins = {
  meta (mn: string, pc: PluginContext): Plugin {
    return {
      name: 'mf-meta',
      async renderChunk (code, chunk) {
        const { importedBindings } = chunk
        const pending: [string, string][] = []
        Object.keys(importedBindings).forEach(
          (imported) => {
            if (isVendorModule(imported)) {
              let vendor = getVendor(imported)
              if (imported.length > vendor.length || pc.shouldVersioned(vendor)) {
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
                ({ n, ss, se }) => {
                  if (n === imported) {
                    const bindings = importedBindings[imported]
                    let content = code.slice(ss, se).replace(/\n/g, ' ')
                    if (imported.length > vendor.length) {
                      if (bindings.length) {
                        const bindingToNameMap: Record<string, string> = {}
                        const d = content.match(/(?<=^import).+?(?=from)/)![0].trim()
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
                          ` } from "${vendor}"`
                      } else {
                        content = `import "${vendor}"`
                      }
                    }
                    if (pc.shouldVersioned(vendor)) {
                      content = content.replace(
                        new RegExp(`(["'])${vendor}\\1`),
                        `"${pc.importerToVendorToVersionedVendorMapMap[getVendor(mn)][vendor]}"`
                      )
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
        const info = pc.getModuleInfo(mn)
        const fileNames = Object.keys(bundle)
        const js = fileNames.find((fileName) => (bundle[fileName] as OutputChunk).isEntry)!
        const css = fileNames.find((fileName) => fileName.endsWith('.css'))
        info.js = js
        css && (info.css = css)
        const { importedBindings } = bundle[js] as OutputChunk
        info.imports = {}
        Object.keys(importedBindings).forEach(
          (imported) => {
            if (isVendorModule(imported)) {
              const rbs = importedBindings[imported]
              const vendor = getVendor(imported)
              const vv = pc.importerToVendorToVersionedVendorMapMap[getVendor(mn)][vendor]
              const bindings = (info.imports[vv] = info.imports[vv] || [])
              const prefix = imported.length > vendor.length || !rbs.length ? imported + '/' : ''
              rbs.length ? rbs.forEach((rb) => bindings.push(prefix + rb)) : bindings.push(prefix)
            }
            if (
              isLocalModule(imported) &&
              !pc.meta.modules[imported] &&
              !pc.sources.find((source) => getLocalModuleName(source.path) === imported)
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
  },
  vendor (vv: string, vpc: VendorPluginContext): Plugin {
    return {
      name: 'mf-vendor',
      enforce: 'pre',
      resolveId (source, importer, options) {
        if (source === vpc.input) {
          return VENDOR
        } else if (importer === VENDOR) {
          return this.resolve(
            source,
            vpc.getPkgJsonPathFromImporter(vpc.versionedVendorToImportersMap[vv][0]),
            Object.assign({ skipSelf: true }, options)
          )
        }
        return null
      },
      load (id) {
        if (id === VENDOR) {
          let names: string[] = []
          let subs: string[] = []
          vpc.curBindings.forEach((binding) => (binding.includes('/') ? subs.push(binding) : names.push(binding)))
          return (
            (names.length
              ? names.includes('*')
                ? `export * from "${vpc.vendor}";`
                : `export { ${names.toString()} } from "${vpc.vendor}";`
              : '') +
            subs
              .map(
                (sub) => {
                  const index = sub.lastIndexOf('/')
                  const path = sub.slice(0, index)
                  const binding = sub.slice(index + 1)
                  const name = sub.replace(/\W/g, SEP)
                  return binding
                    ? binding === '*'
                      ? `export * as ${name} from "${path}";`
                      : `export { ${binding} as ` + `${name} } from "${path}";`
                    : `import "${path}";`
                }
              )
              .join('\n')
          )
        }
      }
    }
  },
  lib (lmn: string, pc: PluginContext): Plugin {
    return {
      name: 'mf-lib',
      async resolveId (source, importer, options) {
        if (source.startsWith('\0')) {
          return null
        }
        if (!source.startsWith('.') && !isAbsolute(source)) {
          throw new Error(
            `'${source}' is imported by ${importer || getLocalModulePath(lmn)},` +
              `but it isn't declared in the dependencies field of the ` +
              resolve(getPkgJsonPath(lmn))
          )
        }
        const resolution = await this.resolve(source, importer, Object.assign({ skipSelf: true }, options))
        if (resolution) {
          const path = getNormalizedPath(resolution.id)
          if (getPkgPathFromLmn(lmn) !== getPkgPathFromPath(path)) {
            throw new Error(
              `'${source}' is imported by ${importer || getLocalModulePath(lmn)},` +
                `importing source cross package is not allowed.`
            )
          }
          if (importer && isIndependentModule(path)) {
            return {
              id: getLocalModuleName(path)!,
              external: true
            }
          }
          const mi = pc.getModuleInfo(lmn)
          mi.sources = mi.sources || []
          mi.sources.push(path)
          return resolution
        }
        return null
      }
    }
  }
}

const build = async (mode?: string) => {
  building = true

  const config = await vite.resolveConfig({ mode }, 'build')
  const mc = await resolveConfig()

  const BASE = config.base
  const DIST = config.build.outDir
  const ASSETS = config.build.assetsDir

  const isLocal = BASE === '/'

  mc.apps.forEach(
    (app) => {
      typeof app.vite === 'function' && (app.vite = app.vite({ command: 'build', mode }, utils))
      app.packages = Array.isArray(app.packages) ? app.packages : app.packages!(getPkgNames(), utils)
    }
  )

  const meta: Meta = await getMeta(isLocal, BASE, DIST)
  const sources = getSources(meta)

  !sources.length && exit()
  await execa('yarn').stdout?.pipe(stdout)
  meta.hash = execa.sync('git', ['rev-parse', '--short', 'HEAD']).stdout
  meta.version = VERSION

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

  const versionedVendorToPkgInfoMap: Record<string, PackageJson> = {}
  const versionedVendorToPkgJsonPathMap: Record<string, string> = {}
  const versionedVendorToImportersMap: PluginContext['versionedVendorToImportersMap'] = {}
  const importerToVendorToVersionedVendorMapMap: PluginContext['importerToVendorToVersionedVendorMapMap'] = {}

  const getPkgJsonPathFromImporter = cached(
    (importer) =>
      isLocalModule(importer) ? rq.resolve(`${importer}/${PACKAGE_JSON}`) : versionedVendorToPkgJsonPathMap[importer]
  )
  const seenDeps: Record<string, true> = {}
  const traverseDeps = (importer: string) => {
    if (seenDeps[importer]) return
    seenDeps[importer] = true
    const pp = getPkgJsonPathFromImporter(importer)
    const { dependencies = {}, peerDependencies = {} } = rq(pp)
    const vendorToVersionedVendorMap: Record<string, string> = (importerToVendorToVersionedVendorMapMap[importer] = {})
    Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach(
      (vendor) => {
        let path = mc.rvpjp && mc.rvpjp(vendor, importer, pp, utils)
        if (path === false) return
        if (!path) {
          const require = createRequire(pp)
          try {
            path = require.resolve(`${vendor}/${PACKAGE_JSON}`)
          } catch (error) {
            path = vite.normalizePath(require.resolve(vendor)).replace(new RegExp(`(?<=/${vendor}/).+`), PACKAGE_JSON)
          }
        }
        const pi = rq(path)
        const vv = getVersionedVendor(vendor, pi.version)
        const importers = (versionedVendorToImportersMap[vv] = versionedVendorToImportersMap[vv] || [])
        importers.push(importer)
        vendorToVersionedVendorMap[vendor] = vv
        versionedVendorToPkgInfoMap[vv] = pi
        versionedVendorToPkgJsonPathMap[vv] = path
        traverseDeps(vv)
      }
    )
    return true
  }

  const versionedVendorToDepInfoMap: Record<string, DepInfo> = {}

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
                  const vv = imported
                  const bindings = (versionedVendorToBindingsSetMap[vv] =
                    versionedVendorToBindingsSetMap[vv] || new Set())
                  imports[vv].forEach((binding) => bindings.add(binding))
                }
              }
            )
          }
        }
      }
    )
    let vvs = new Set(Object.keys(versionedVendorToBindingsSetMap))
    if (!isPre) {
      Object.keys(versionedVendorToImportersMap).forEach(
        (vv) => versionedVendorToImportersMap[vv].length > 1 && vvs.add(vv)
      )
      const getDepsInfo = cached(
        (vv) =>
          (versionedVendorToDepInfoMap[vv] = versionedVendorToDepInfoMap[vv] || {
            dependencies: [],
            dependents: []
          })
      )
      vvs.forEach(
        (vv) => {
          const di = getDepsInfo(vv)
          const { peerDependencies = {}, dependencies = {} } = versionedVendorToPkgInfoMap[vv]
          Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach(
            (vendor) => vvs.has(importerToVendorToVersionedVendorMapMap[vv][vendor]) && di.dependencies.push(vendor)
          )
          di.dependencies.forEach(
            (vendor) => {
              const ivv = importerToVendorToVersionedVendorMapMap[vv][vendor]
              const idi = getDepsInfo(ivv)
              idi.dependents.push(vv)
            }
          )
        }
      )
    }
    const versionedVendorToBindingsMap: Record<string, string[]> = {}
    vvs.forEach(
      (vv) => {
        if (versionedVendorToBindingsSetMap[vv]) {
          versionedVendorToBindingsMap[vv] = Array.from(versionedVendorToBindingsSetMap[vv])
          versionedVendorToBindingsMap[vv].sort()
        } else {
          versionedVendorToBindingsMap[vv] = []
        }
      }
    )
    return versionedVendorToBindingsMap
  }

  getPkgNames().forEach((pn) => traverseDeps(pn))

  const vendorToVersionedVendorsMap: Record<string, string[]> = {}
  Object.keys(versionedVendorToImportersMap).forEach(
    (vv) => {
      const vendor = getUnversionedVendor(vv)
      vendorToVersionedVendorsMap[vendor] = vendorToVersionedVendorsMap[vendor] || []
      vendorToVersionedVendorsMap[vendor].push(vv)
    }
  )

  const pvv2bm = getVersionedVendorToBindingsMap(true)

  const pc: PluginContext = {
    meta,
    sources,
    versionedVendorToImportersMap,
    importerToVendorToVersionedVendorMapMap,
    getModuleInfo,
    shouldVersioned: (vendor) => vendorToVersionedVendorsMap[vendor].length > 1,
    getPkgJsonPathFromImporter
  }

  const builder = {
    vendor: cached(
      async (vv) => {
        const info = versionedVendorToDepInfoMap[vv]
        const preBindings = pvv2bm[vv]
        if (info.dependents) {
          await Promise.all(info.dependents.map(builder.vendor))
          const curBindingsSet = new Set(cvv2bm[vv])
          info.dependents.forEach(
            (ivv) => meta.modules[ivv]?.imports[vv]?.forEach((binding) => curBindingsSet.add(binding))
          )
          cvv2bm[vv] = Array.from(curBindingsSet).sort()
        }
        const curBindings = cvv2bm[vv]
        if (preBindings?.toString() !== curBindings.toString()) {
          remove(vv)
          if (!curBindings.length) return
          const vendor = getUnversionedVendor(vv)
          const input = resolve(VENDOR)
          return vite.build(
            {
              mode,
              publicDir: false,
              build: {
                rollupOptions: {
                  input,
                  output: {
                    entryFileNames: `${ASSETS}/${vv}.[hash].js`,
                    chunkFileNames: `${ASSETS}/${vv}.[hash].js`,
                    assetFileNames: `${ASSETS}/${vv}.[hash][extname]`,
                    format: 'es',
                    manualChunks: {}
                  },
                  preserveEntrySignatures: 'allow-extension',
                  external: info.dependencies.map((dep) => new RegExp('^' + dep + '(/.+)?$'))
                }
              },
              plugins: [plugins.vendor(vv, Object.assign({ input, vendor, curBindings }, pc)), plugins.meta(vv, pc)]
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
          plugins: [plugins.lib(lmn, pc), plugins.meta(lmn, pc)]
        }
        const pn = getPkgName(lmn)
        const app = mc.apps.find((app) => (app.packages as string[]).includes(pn))
        if (!app) {
          throw new Error(`'${pn}' doesn't have corresponding app.`)
        }
        const uc = app.vite
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
              plugins.meta(rmn, pc)
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
                const getKey = cached(
                  (mn) =>
                    isVendorModule(mn) && vendorToVersionedVendorsMap[getUnversionedVendor(mn)].length === 1
                      ? getUnversionedVendor(mn)
                      : mn
                )
                const imports = importmap.imports
                interface MFModulesInfo {
                  js: string
                  css?: string
                  imports: string[]
                }
                const mm: Record<string, MFModulesInfo> = {}
                Object.keys(meta.modules).forEach(
                  (mn) => {
                    const key = getKey(mn)
                    imports[key] = BASE + meta.modules[mn].js
                    const mfi: MFModulesInfo = (mm[key] = {
                      js: meta.modules[mn].js,
                      imports: []
                    })
                    meta.modules[mn].css && (mfi.css = meta.modules[mn].css)
                    Object.keys(meta.modules[mn].imports).forEach((imported) => mfi.imports.push(getKey(imported)))
                  }
                )

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
                        `window.mf.modules = ${JSON.stringify(mm)}`
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
        const lmn = getLocalModuleName(path)
        if (status === 'D') {
          return lmn && remove(lmn)
        }
        if (lmn) {
          if (isPage(path)) {
            return Promise.all(
              [builder.lib(lmn), ...(status === 'A' ? getRoutesMoudleNames(path).map(builder.routes) : [])]
            )
          }
          return builder.lib(lmn)
        } else {
          return Promise.all(
            Object.keys(meta.modules)
              .filter((mn) => meta.modules[mn].sources?.includes(path))
              .map(builder.lib)
          )
        }
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
      .filter((vv) => !versionedVendorToDepInfoMap[vv].dependencies.length)
      .map(builder.vendor)
  )

  await builder.entry()
  await writeFile(resolve(DIST, `meta.json`), JSON.stringify(meta))
}

export { SEP, VENDOR, building, plugins, build }
