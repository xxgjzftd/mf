import { dirname, isAbsolute, resolve } from 'path'
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
  isPage,
  isLocalModule,
  isVendorModule,
  isIndependentModule,
  getSrcPathes,
  getPkgPathes,
  getNormalizedPath,
  getPkgName,
  getVendor,
  getLocalModuleName,
  getLocalModulePath,
  getAlias,
  getExternal,
  getVersionedVendor,
  getUnversionedVendor,
  getPkgPath,
  getPkgPathFromLmn,
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
  sources?: string[]
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
  const getRequireParent = cached(
    (importer) =>
      isLocalModule(importer)
        ? require.resolve(`${getPkgName(importer)}/${PACKAGE_JSON}`)
        : versionedVendorToPkgJsonPathMap[importer]
  )

  const getVendorPkgInfo = (vendor: string, importer: string): PackageJson => {
    let parent = getRequireParent(importer)
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
    return require(path)
  }

  const vendorToVersionedVendorMap: Record<string, string> = {}
  const importerToVendorToVersionedVendorMapMap: Record<string, typeof vendorToVersionedVendorMap> = {}
  const versionedVendorToImportersMap: Record<string, string[]> = {}
  const versionedVendorToPkgInfoMap: Record<string, PackageJson> = {}
  const traverseVendorDeps = (vendor: string, importer: string) => {
    const pi = getVendorPkgInfo(vendor, importer)
    const { version, dependencies = {}, peerDependencies = {} } = pi
    const vv = getVersionedVendor(vendor, version!)
    const hasTraversed = !!versionedVendorToImportersMap[vv]
    const importers = (versionedVendorToImportersMap[vv] = versionedVendorToImportersMap[vv] || [])
    importers.push(importer)
    versionedVendorToPkgInfoMap[vv] = pi
    hasTraversed ||
      Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach((vendor) => traverseVendorDeps(vendor, vv))
  }

  const getPkgJsonPath = cached(
    (importer) =>
      isLocalModule(importer)
        ? require.resolve(`${importer}/${PACKAGE_JSON}`)
        : versionedVendorToPkgJsonPathMap[importer]
  )
  const traverseDeps = cached(
    (importer) => {
      const pp = getPkgJsonPath(importer)
      const { dependencies = {}, peerDependencies = {} } = require(pp)
      const importers = (versionedVendorToImportersMap[importer] = versionedVendorToImportersMap[importer] || [])
      importers.push(importer)
      Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach(
        (vendor) => {
          let path = mc.rvpjp && mc.rvpjp(vendor, importer, pp, utils)
          if (!path) {
            const require = createRequire(pp)
            try {
              path = require.resolve(`${vendor}/${PACKAGE_JSON}`)
            } catch (error) {
              path = vite.normalizePath(require.resolve(vendor)).replace(new RegExp(`(?<=/${vendor}/).+`), PACKAGE_JSON)
            }
          }
          const pi = require(path)
          versionedVendorToPkgInfoMap[importer] = pi
          versionedVendorToPkgJsonPathMap[getVersionedVendor(vendor, pi.version)] = path
        }
      )
    }
  )

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
                  imports[vv].forEach(bindings.add)
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
      vvs.forEach(
        (vv) => {
          const di = (versionedVendorToDepInfoMap[vv] = versionedVendorToDepInfoMap[vv] || {
            dependencies: [],
            dependents: []
          })
          const { peerDependencies = {}, dependencies = {} } = versionedVendorToPkgInfoMap[vv]
          di.dependencies = []
          Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach(
            (dep) => vvs.has(dep) && di.dependencies.push(dep)
          )
          di.dependencies.forEach(
            (ivv) => {
              const idi = (versionedVendorToDepInfoMap[ivv] = versionedVendorToDepInfoMap[ivv] || {})
              idi.dependents = idi.dependents || []
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

  getPkgPathes().forEach(
    (pp) => {
      const pjp = resolve(pp, PACKAGE_JSON)
      const pi = require(pjp)
      const { dependencies = {}, peerDependencies = {} } = pi
      Object.keys(Object.assign({}, dependencies, peerDependencies)).forEach(
        (vendor) => traverseVendorDeps(vendor, require(pjp).name)
      )
    }
  )

  const vendorToVersionedVendorsMap: Record<string, string[]> = {}
  Object.keys(versionedVendorToImportersMap).forEach(
    (vv) => {
      const vendor = getUnversionedVendor(vv)
      vendorToVersionedVendorsMap[vendor] = vendorToVersionedVendorsMap[vendor] || []
      vendorToVersionedVendorsMap[vendor].push(vv)
    }
  )

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
                if (imported.length > vendor.length || vendorToVersionedVendorsMap[vendor].length > 1) {
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
                            `} from "${vendor}"`
                        } else {
                          content = `import "${vendor}"`
                        }
                      }
                      if (vendorToVersionedVendorsMap[vendor].length > 1) {
                        content = content.replace(
                          new RegExp(`(["'])${vendor}\\1`),
                          getVersionedVendor(vendor, getVendorPkgInfo(vendor, mn).version!)
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
          const info = getModuleInfo(mn)
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
                const vv = getVersionedVendor(vendor, getVendorPkgInfo(vendor, mn).version!)
                const bindings = (info.imports[vv] = info.imports[vv] || [])
                const prefix = imported.length > vendor.length || !rbs.length ? imported + '/' : ''
                rbs.length ? rbs.forEach((rb) => bindings.push(prefix + rb)) : bindings.push(prefix)
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
      async (vv) => {
        const info = versionedVendorToDepInfoMap[vv]
        const preBindings = pvv2bm[vv]
        if (info.dependents) {
          await Promise.all(info.dependents.map(builder.vendor))
          const curBindingsSet = new Set(cvv2bm[vv])
          info.dependents.forEach((ivv) => meta.modules[ivv].imports[vv]?.forEach(curBindingsSet.add))
          cvv2bm[vv] = Array.from(curBindingsSet).sort()
        }
        const curBindings = cvv2bm[vv]
        if (!preBindings || preBindings.toString() !== curBindings.toString()) {
          remove(vv)
          const input = resolve(VENDOR)
          return vite.build(
            {
              mode,
              publicDir: false,
              root: dirname(getRequireParent(versionedVendorToImportersMap[vv][0])),
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
                      const vendor = getUnversionedVendor(vv)
                      return (
                        (names.length
                          ? names.includes('*')
                            ? `export * from "${vendor}";`
                            : `export { ${names.toString()} } from "${vendor}";`
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
                },
                plugins.meta(vv)
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
                const resolution = await this.resolve(source, importer, Object.assign({ skipSelf: true }, options))
                if (resolution) {
                  const path = getNormalizedPath(resolution.id)
                  if (getPkgPathFromLmn(lmn) !== getPkgPath(path)) {
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
                  const mi = getModuleInfo(lmn)
                  mi.sources = mi.sources || []
                  mi.sources.push(path)
                  return resolution
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
      .map((vv) => builder.vendor(vv))
  )

  await builder.entry()
  await writeFile(resolve(DIST, `meta.json`), JSON.stringify(meta))
}

export { building, build }
