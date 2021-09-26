import { readlinkSync } from 'fs'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import { createRequire } from 'module'
import { cwd } from 'process'

import fg from 'fast-glob'
import { normalizePath } from 'vite'

import type { PackageJson } from 'type-fest'
import type { UserConfig } from 'vite'

export interface BaseRoute {
  id: string
  path: string
  name: string
  depth: number
  component: string
  children?: BaseRoute[]
}

type RouteExtend = Partial<Pick<BaseRoute, 'path' | 'name' | 'depth'>> & Pick<BaseRoute, 'id'>

export interface RoutesOption {
  glob: Parameters<typeof fg>
  base?: string
  depth: number
  extends: RouteExtend[]
}

interface BuildEnv {
  command: string
  mode?: string
}

interface AppConfig {
  name: string
  predicate?: (pathname: string) => boolean
  /**
   * App specific vite config.
   */
  vite?: ((env: BuildEnv, utils: typeof import('./utils')) => UserConfig) | UserConfig
  /**
   * Determines which packages belong to this app.
   * The filtered packages will be built with the app specific config.
   * `mf` could't resolve deps of the app automatically unless we build the whole app.
   * But it's not consistent with the goal of our incremental build.
   * @param packages A package name array.
   * @param utils A util set that `mf` use it internally.
   */
  packages?: ((packages: string[], utils: typeof import('./utils')) => string[]) | string[]
}

export interface MFConfig {
  scope: string
  /**
   * Specified sources which participate the build. The build will respect their changes.
   * @default All files in workspaces.
   */
  glob?: Parameters<typeof fg>
  /**
   * Source which has extension specified in this config and its pkg doesn't have the `main` field
   * will be built as a independent module.
   */
  extensions: string[]
  apps: AppConfig[]
  routes?: Record<string, RoutesOption>
  /**
   * Abbreviation for resolve vendor package.json path.
   * A escape hatch for vendor which package.json path couldn't resolved by mf.
   * It's unnecessary when there is no resolve error.
   * @param vendor
   * @param importer May be local module or versioned vendor. Actually, it's a key of meta.modules.
   * @param parent The path of the importer, when importer is a local module. Otherwise, it's the path of importer's package.json.
   * @param utils
   */
  rvpjp?(vendor: string, importer: string, parent: string, utils: typeof import('./utils')): string | null
}

const ROUTES_PACKAGE_NAME = '@mf/routes'
const PACKAGE_JSON = 'package.json'
const SRC = 'src'

const routesModuleNameRegExp = new RegExp(`^${ROUTES_PACKAGE_NAME}/`)

let config: MFConfig

const rq = createRequire(resolve(PACKAGE_JSON))

const once = <T extends (...args: any) => any>(fn: T): T => {
  let res: ReturnType<T>
  return function (this: ThisParameterType<T>, ...args) {
    return res ? res : (res = fn.call(this, ...args))
  } as T
}

const cached = <T extends (string: string) => any>(fn: T) => {
  const cache: Record<string, ReturnType<T>> = Object.create(null)
  return ((string) => cache[string] || (cache[string] = fn(string))) as T
}

const resolveConfig = once(
  async (ic?: MFConfig) => {
    config = ic || (await import(pathToFileURL(resolve('mf.config.js')).href).then((res) => res.default))
    config.scope[0] !== '@' && (config.scope = '@' + config.scope)
    config.scope[config.scope.length - 1] === '/' && (config.scope = config.scope.slice(0, -1))
    config.glob = config.glob || [getPkgPathes().map((pattern: string) => pattern + '**')]
    const dac = {
      predicate: () => true,
      vite: () => ({}),
      packages: getPkgNames()
    }
    config.apps.forEach(
      async (app) => {
        app.predicate = app.predicate || dac.predicate
        app.vite = app.vite || dac.vite
        app.packages = app.packages || dac.packages
      }
    )
    return config
  }
)

const isPkg = cached((lmn) => getPkgName(lmn) === lmn)
const isPage = cached((path) => !!getRoutesMoudleNames(path).length)
const isLocalModule = cached((mn) => mn.startsWith(`${config.scope}/`))
const isRoutesModule = cached((mn) => mn.startsWith(ROUTES_PACKAGE_NAME))
const isVendorModule = cached((mn) => !isLocalModule(mn) && !isRoutesModule(mn))
const isIndependentModule = cached((path) => getLocalModuleName(path) && !isPkg(getLocalModuleName(path)!))

const getSanitizedFgOptions = (options: Parameters<typeof fg>[1]) =>
  Object.assign(
    {
      ignore: ['**/node_modules/**']
    },
    options!,
    {
      absolute: false,
      objectMode: false,
      onlyDirectories: false,
      onlyFiles: true,
      stats: false,
      unique: true
    }
  )

const getAppPkgName = cached((an) => `${config.scope}/${an}`)

const getApps = once(
  () => {
    config.apps.forEach(
      (app) => {
        try {
          rq(`${getAppPkgName(app.name)}/${PACKAGE_JSON}`)
        } catch (error) {
          throw new Error(`'${getAppPkgName(app.name)}' doesn't exist in this project.`)
        }
      }
    )
    return config.apps
  }
)

const getSrcPathes = once(
  () => {
    const [source, options = {}] = config.glob!
    return fg.sync(source, getSanitizedFgOptions(options))
  }
)

const getPkgPathes = once(
  () =>
    fg
      .sync('node_modules/' + config.scope + '/*', { onlyDirectories: true, markDirectories: true })
      .map((path) => getNormalizedPath(readlinkSync(path)))
)

const getPkgNames = once(() => getPkgPathes().map((pp) => rq(resolve(pp, PACKAGE_JSON)).name))

const getNormalizedPath = cached((ap) => normalizePath(ap).slice(normalizePath(cwd()).length + 1))

const getRoutesMoudleNameToPagesMap = once(
  () => {
    const rmn2pm: Record<string, string[]> = {}
    if (config.routes) {
      Object.keys(config.routes).forEach(
        (subpath) => {
          const [source, options = {}] = config.routes![subpath].glob
          rmn2pm[`${ROUTES_PACKAGE_NAME}/${subpath}`] = fg.sync(source, getSanitizedFgOptions(options))
        }
      )
    }
    return rmn2pm
  }
)

const getRoutesOption = cached((rmn) => config.routes![rmn.slice(ROUTES_PACKAGE_NAME.length + 1)])

const getRoutesMoudleNames = cached(
  (path) => {
    const rmn2pm = getRoutesMoudleNameToPagesMap()
    return Object.keys(rmn2pm).filter((rmn) => rmn2pm[rmn].includes(path))
  }
)

const getPkgPathFromPath = cached(
  (path) => {
    const pp = getPkgPathes().find((pp) => path.startsWith(pp))
    if (!pp) {
      throw new Error(
        `'${path}' is include in the building because of the 'glob' \n` +
          JSON.stringify(config.glob) +
          `\nspecified in the ${resolve('mf.config.js')}.\n` +
          `but it doesn't exist in the workspaces which is specified in the ${resolve('package.json')}`
      )
    }
    return pp.slice(0, -1)
  }
)

const getPkgJsonPath = cached((lmn) => getNormalizedPath(rq.resolve(`${getPkgName(lmn)}/${PACKAGE_JSON}`)))

const getPkgPathFromLmn = cached((lmn) => getPkgJsonPath(lmn).slice(0, -(PACKAGE_JSON.length + 1)))

const getPkgInfoFromPath = cached((path): PackageJson => rq(resolve(getPkgPathFromPath(path), PACKAGE_JSON)))

const getPkgInfoFromLmn = cached((lmn): PackageJson => rq(`${getPkgName(lmn)}/${PACKAGE_JSON}`))

const getPkgName = cached((lmn) => lmn.split('/', 2).join('/'))

const getVendor = cached((mn) => mn.split('/', mn[0] === '@' ? 2 : 1).join('/'))

const getVersionedVendor = (vendor: string, version: string) => vendor + '@' + version

const getUnversionedVendor = cached((vv) => vv.slice(0, vv.lastIndexOf('@')))

const getLocalModuleName = cached(
  (path) => {
    const pp = getPkgPathFromPath(path)
    const pi = getPkgInfoFromPath(path)
    const { main, name } = pi
    if (!name || !name.startsWith(config.scope)) {
      throw new Error(
        `${resolve(pp, PACKAGE_JSON)} doesn't specified 'name' field or ` +
          `the 'name' field doesn't start with '${config.scope}'.`
      )
    }
    if (isPage(path) || (!main && config.extensions.includes(path.slice(path.lastIndexOf('.') + 1)))) {
      return path.replace(pp, name)
    }
    if (main && getNormalizedPath(resolve(pp, main)) === path) {
      return name
    }
    return null
  }
)

const getLocalModulePath = cached(
  (lmn) =>
    isPkg(lmn)
      ? getNormalizedPath(resolve(getPkgPathFromLmn(lmn), getPkgInfoFromLmn(lmn).main!))
      : getPkgPathFromLmn(lmn) + lmn.slice(getPkgName(lmn).length)
)

const getPkgId = cached((lmn) => lmn.split('/', 2)[1])

const getAliasKey = cached((lmn) => '@' + getPkgId(lmn))

const getAlias = cached(
  (lmn) => {
    const pn = getPkgName(lmn)
    const pjp = rq.resolve(`${pn}/${PACKAGE_JSON}`)
    const ak = getAliasKey(lmn)
    const rd = normalizePath(pjp).replace(PACKAGE_JSON, SRC)
    return [
      {
        find: ak,
        replacement: (_m: string, _o: number, specifier: string) =>
          isIndependentModule(specifier.replace(ak, getNormalizedPath(rd))) ? `${pn}/${SRC}` : rd
      }
    ]
  }
)

const getDevAlias = () => {
  const alias: Record<string, string> = {}
  getPkgPathes().forEach(
    (pp) => {
      const pjp = resolve(pp, PACKAGE_JSON)
      const { name } = rq(pjp)
      const ak = getAliasKey(name)
      alias[ak] = normalizePath(pjp).replace(PACKAGE_JSON, SRC)
    }
  )
  return alias
}

const getExternal = cached(
  (lmn) => [
    ...Object.keys(getPkgInfoFromLmn(lmn).dependencies || {}).map((dep) => new RegExp('^' + dep + '(/.+)?$')),
    new RegExp(`^${config.scope}/`),
    routesModuleNameRegExp
  ]
)

const stringify = (payload: any, replacer?: (key: string | number, value: any) => string | void): string => {
  const type = typeof payload
  switch (type) {
    case 'object':
      const isArray = Array.isArray(payload)
      let content = (
        isArray
          ? payload.map(
              (value: any, index: number) => (replacer && replacer(index, value)) ?? stringify(value, replacer)
            )
          : Object.keys(payload).map(
              (key) => `${key}:${(replacer && replacer(key, payload[key])) ?? stringify(payload[key], replacer)}`
            )
      ).join(',')
      return (replacer && replacer('', payload)) ?? isArray ? `[${content}]` : `{${content}}`
    case 'function':
      return payload.toString()
    default:
      return JSON.stringify(payload)
  }
}

export {
  ROUTES_PACKAGE_NAME,
  PACKAGE_JSON,
  config,
  resolveConfig,
  rq,
  once,
  cached,
  isPkg,
  isPage,
  isLocalModule,
  isRoutesModule,
  isVendorModule,
  isIndependentModule,
  getAppPkgName,
  getApps,
  getSrcPathes,
  getPkgPathes,
  getPkgNames,
  getNormalizedPath,
  getRoutesMoudleNameToPagesMap,
  getRoutesOption,
  getRoutesMoudleNames,
  getPkgJsonPath,
  getPkgPathFromPath,
  getPkgPathFromLmn,
  getPkgInfoFromPath,
  getPkgName,
  getVendor,
  getVersionedVendor,
  getUnversionedVendor,
  getLocalModuleName,
  getLocalModulePath,
  getPkgId,
  getAlias,
  getDevAlias,
  getExternal,
  stringify
}
