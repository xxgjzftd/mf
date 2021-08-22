import { resolve } from 'path'
import { createRequire } from 'module'

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

const config: MfConfig = await import(resolve('mf.config.js'))

const require = createRequire(import.meta.url)

const localModuleNameRegExp = new RegExp(`^${config.scope}/`)

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

const getRoutesMoudleNames = cached(
  (path) => {
    const rmn2pm = getRoutesMoudleNameToPagesMap()
    return Object.keys(rmn2pm).filter((routesMouduleName) => rmn2pm[routesMouduleName].find((page) => page === path))
  }
)

const getPkgPath = cached((path) => getPkgPathes().find((pp) => path.startsWith(pp))!)
const getPkgInfo = cached((path) => require(resolve(getPkgPath(path), PACKAGE_JSON)))

const getLocalModuleName = cached(
  (path) => {
    const pkg = getPkgInfo(path)
    const { main, name } = pkg
    if (main && !isPage(path)) {
      return name
    } else {
      return path.replace(/.+?\/.+?(?=\/)/, name)
    }
  }
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
  getVendorPkgInfo,
  stringify
}
