import { resolve } from 'path'
import { createRequire } from 'module'
import { cwd } from 'process'

import fg from 'fast-glob'
import { normalizePath } from 'vite'

import type { PackageJson } from 'type-fest'
import type { RouteRecordRaw } from 'vue-router'

interface RouteExtend<T> {
  id: string
  depth: number
  route: T
}

interface RoutesOption {
  type: string
  glob: Parameters<typeof fg>
  defaultDepth: number
}

interface VueRoutesOption extends RoutesOption {
  type: 'vue'
  extends: RouteExtend<RouteRecordRaw>[]
}

export interface MfConfig {
  scope: string
  glob: Parameters<typeof fg>
  routes?: Record<string, VueRoutesOption>
}

const ROUTES = 'routes'
const ROUTES_PACKAGE_NAME = '@mf/routes'
const PACKAGE_JSON = 'package.json'
const SRC = 'src'

const config: MfConfig = await import(resolve('mf.config.js'))

const require = createRequire(import.meta.url)

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

const isPage = cached((path) => !!getRoutesMoudleNames(path).length)
const isLocalModule = cached((mn) => localModuleNameRegExp.test(mn))
const isRoutesModule = cached((mn) => mn.startsWith(ROUTES_PACKAGE_NAME))

const getSanitizedFgOptions = (options: Parameters<typeof fg>[1]) =>
  Object.assign(
    {},
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

const getSrcPathes = once(
  () => {
    const [source, options = {}] = config.glob
    return fg.sync(source, getSanitizedFgOptions(options))
  }
)

const getPkgPathes = once(
  () => fg.sync(require(resolve(PACKAGE_JSON)).workspaces, { onlyDirectories: true, markDirectories: true })
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

const getNormalizedPath = cached((ap) => normalizePath(ap.replace(cwd(), '')).slice(1))

const getRoutesMoudleNames = cached(
  (path) => {
    const rmn2pm = getRoutesMoudleNameToPagesMap()
    return Object.keys(rmn2pm).filter((routesMouduleName) => rmn2pm[routesMouduleName].includes(path))
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

const getLocalModuleName = cached(
  (path) => {
    const pp = getPkgPath(path)
    const pkg = getPkgInfo(path)
    const { main, name } = pkg
    if (!name || !name.startsWith(config.scope)) {
      throw new Error(
        `${resolve(pp, PACKAGE_JSON)} doesn't specified 'name' field or ` +
          `the 'name' field doesn't start with ${config.scope}.`
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
    getPkgName(lmn) === lmn
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

const getAliasKey = cached((lmn) => '@' + lmn.split('/', 2)[1])

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
            // here pp means public path
            const pp = specifier.replace(ak, `${pn}/${SRC}`)
            const path = getNormalizedPath(require.resolve(pp))
            return getSrcPathes().includes(path) ? pp : rp
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

const stringify = (payload: any, replacer?: (key: string | number, value: any) => string): string => {
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
  ROUTES,
  config,
  cached,
  isPage,
  isLocalModule,
  isRoutesModule,
  getSrcPathes,
  getRoutesMoudleNames,
  getLocalModuleName,
  getLocalModulePath,
  getVendorPkgInfo,
  getAlias,
  getDevAlias,
  getExternal,
  stringify
}
