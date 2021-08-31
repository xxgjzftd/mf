import { pathToFileURL } from 'url'
import { resolve } from 'path'
import { createRequire } from 'module'
import { cwd } from 'process'

import fg from 'fast-glob'
import { normalizePath } from 'vite'

import type { PackageJson } from 'type-fest'
import type { UserConfig } from 'vite'

interface RouteExtend {
  id: string
  depth: number
  route: Record<string, any>
}

interface RoutesOption {
  glob: Parameters<typeof fg>
  base?: string
  depth: number
  extends: RouteExtend[]
}

interface AppConfig {
  name: string
  predicate: () => boolean
}

export interface MfConfig {
  scope: string
  glob: Parameters<typeof fg>
  extensions: string[]
  apps: AppConfig[]
  routes?: Record<string, RoutesOption>
  vite(lmn: string, utils: typeof import('./utils')): UserConfig
}

const ROUTES_PACKAGE_NAME = '@mf/routes'
const PACKAGE_JSON = 'package.json'
const SRC = 'src'

const config: MfConfig = await import(pathToFileURL(resolve('mf.config.js')).href).then((res) => res.default)

config.scope[0] !== '@' && (config.scope = '@' + config.scope)
config.scope[config.scope.length - 1] === '/' && (config.scope = config.scope.slice(0, -1))

const require = createRequire(resolve(PACKAGE_JSON))

const localModuleNameRegExp = new RegExp(`^${config.scope}/`)
const routesModuleNameRegExp = new RegExp(`^${ROUTES_PACKAGE_NAME}/`)

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

const isPkg = cached((lmn) => getPkgName(lmn) === lmn)
const isPage = cached((path) => !!getRoutesMoudleNames(path).length)
const isLocalModule = cached((mn) => localModuleNameRegExp.test(mn))
const isRoutesModule = cached((mn) => mn.startsWith(ROUTES_PACKAGE_NAME))

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

const getMFConfig = once(() => config)

const getAppPkgName = cached((an) => `${config.scope}/${an}`)

const getApps = once(
  () => {
    config.apps.forEach(
      (app) => {
        try {
          require(`${getAppPkgName(app.name)}/${PACKAGE_JSON}`)
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
    const [source, options = {}] = config.glob
    return fg.sync(source, getSanitizedFgOptions(options))
  }
)

const getPkgPathes = once(
  () =>
    fg.sync(
      require(resolve(PACKAGE_JSON)).workspaces,
      { ignore: ['**/node_modules/**'], onlyDirectories: true, markDirectories: true }
    )
)

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

const getNormalizedPath = cached((ap) => normalizePath(ap).replace(normalizePath(cwd()), '').slice(1))

const getRoutesMoudleNames = cached(
  (path) => {
    const rmn2pm = getRoutesMoudleNameToPagesMap()
    return Object.keys(rmn2pm).filter((rmn) => rmn2pm[rmn].includes(path))
  }
)

const getPkgPath = cached(
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

const getPkgPathFromLmn = cached(
  (lmn) => getNormalizedPath(require.resolve(`${getPkgName(lmn)}/${PACKAGE_JSON}`)).slice(0, -(PACKAGE_JSON.length + 1))
)

const getPkgInfo = cached((path): PackageJson => require(resolve(getPkgPath(path), PACKAGE_JSON)))

const getPkgInfoFromLmn = cached((lmn): PackageJson => require(resolve(getPkgPathFromLmn(lmn), PACKAGE_JSON)))

const getPkgName = cached((lmn) => lmn.split('/', 2).join('/'))

const getVendor = cached((mn) => mn.split('/', mn[0] === '@' ? 2 : 1).join('/'))

const getLocalModuleName = cached(
  (path) => {
    const pp = getPkgPath(path)
    const pi = getPkgInfo(path)
    const { main, name } = pi
    if (!name || !name.startsWith(config.scope)) {
      throw new Error(
        `${resolve(pp, PACKAGE_JSON)} doesn't specified 'name' field or ` +
          `the 'name' field doesn't start with '${config.scope}'.`
      )
    }
    if (main && !isPage(path)) {
      return name
    } else {
      return path.replace(pp, name)
    }
  }
)

const getLocalModulePath = cached(
  (lmn) =>
    isPkg(lmn)
      ? getNormalizedPath(resolve(getPkgPathFromLmn(lmn), require(`${getPkgName(lmn)}/${PACKAGE_JSON}`).main))
      : getPkgPathFromLmn(lmn) + lmn.slice(getPkgName(lmn).length)
)

const getVendorPkgInfo = cached(
  (mn) => {
    let pkgInfo: PackageJson
    try {
      pkgInfo = require(`${mn}/${PACKAGE_JSON}`)
    } catch (error) {
      pkgInfo = require(normalizePath(require.resolve(mn)).replace(new RegExp(`(?<=${mn}).+`), '/' + PACKAGE_JSON))
    }
    return pkgInfo
  }
)

const getPkgId = cached((lmn) => lmn.split('/', 2)[1])

const getAliasKey = cached((lmn) => '@' + getPkgId(lmn))

const getAlias = cached(
  (lmn) => {
    const pn = getPkgName(lmn)
    const pjp = require.resolve(`${pn}/${PACKAGE_JSON}`)
    const { main } = require(pjp)
    const ak = getAliasKey(lmn)
    const rp = normalizePath(pjp).replace(PACKAGE_JSON, SRC)
    return [
      {
        find: ak,
        replacement (_m: string, _o: number, specifier: string) {
          if (main) {
            // means that some sources may be bundled multiple times in some edge case
            return rp
          } else {
            return config.extensions.includes(specifier.slice(specifier.lastIndexOf('.'))) ? `${pn}/${SRC}` : rp
          }
        }
      }
    ]
  }
)

const getDevAlias = () => {
  const alias: Record<string, string> = {}
  getPkgPathes().forEach(
    (pp) => {
      const pjp = resolve(pp, PACKAGE_JSON)
      const { name } = require(pjp)
      const ak = getAliasKey(name)
      alias[ak] = normalizePath(pjp).replace(PACKAGE_JSON, SRC)
    }
  )
  return alias
}

const getExternal = cached(
  (lmn) => [
    ...Object.keys(getPkgInfoFromLmn(lmn).dependencies || {}).map((dep) => new RegExp('^' + dep + '(/.+)?$')),
    localModuleNameRegExp,
    routesModuleNameRegExp
  ]
)

const stringify = (payload: any, replacer?: (key: string | number, value: any) => string | void): string => {
  const type = typeof payload
  switch (type) {
    case 'object':
      const isArray = Array.isArray(payload)
      let content = isArray
        ? payload.map((value: any, index: number) => (replacer && replacer(index, value)) ?? stringify(value, replacer))
        : Object.keys(payload).map(
            (key) => `${key}:${(replacer && replacer(key, payload[key])) ?? stringify(payload[key], replacer)}`
          )
      content = content.join(',')
      return (replacer && replacer('', payload)) ?? isArray ? `[${content}]` : `{${content}}`
    case 'function':
      return payload.toString()
    default:
      return JSON.stringify(payload)
  }
}

export {
  PACKAGE_JSON,
  config,
  require,
  cached,
  isPkg,
  isPage,
  isLocalModule,
  isRoutesModule,
  getMFConfig,
  getAppPkgName,
  getApps,
  getSrcPathes,
  getRoutesMoudleNameToPagesMap,
  getRoutesOption,
  getRoutesMoudleNames,
  getPkgPathFromLmn,
  getPkgInfo,
  getPkgName,
  getVendor,
  getLocalModuleName,
  getLocalModulePath,
  getVendorPkgInfo,
  getPkgId,
  getAlias,
  getDevAlias,
  getExternal,
  stringify
}
