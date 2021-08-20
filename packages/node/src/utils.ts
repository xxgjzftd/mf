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
  routes?: Record<string, VueRoutesOption>
}

const config: MfConfig = await import(resolve('mf.config.js'))

const require = createRequire(import.meta.url)

const ROUTES = 'routes'
const ROUTES_PACKAGE_NAME = '@mf/routes'

const routesMouduleNameToPagesMap: Record<string, string[]> = {}
if (config.routes) {
  Object.keys(config.routes).forEach(
    (subpath) => {
      const [source, options = {}] = config.routes![subpath].glob
      routesMouduleNameToPagesMap[`${ROUTES_PACKAGE_NAME}/${subpath}`] = fg.sync(
        source,
        Object.assign(
          {},
          options,
          { absolute: false, objectMode: false, onlyDirectories: false, onlyFiles: true, stats: false, unique: true }
        )
      )
    }
  )
}

const localModuleNameRegExp = new RegExp(`^${config.scope}/`)

const cached = <T>(fn: (str: string) => T) => {
  const cache: Record<string, T> = Object.create(null)
  return (str: string) => cache[str] || (cache[str] = fn(str))
}

const isPage = cached((path) => !!getRoutesMoudleNames(path).length)
const isLocalModule = cached((mn) => localModuleNameRegExp.test(mn))
const isRoutesModule = cached((mn) => mn.startsWith(ROUTES_PACKAGE_NAME))

const getRoutesMoudleNames = cached(
  (path) => {
    return Object.keys(routesMouduleNameToPagesMap).filter(
      (routesMouduleName) => routesMouduleNameToPagesMap[routesMouduleName].find((page) => page === path)
    )
  }
)

const getPkgId = cached((path) => path.replace(/^packages\/(.+?)\/.+/, '$1'))

const getPkgInfoFromPkgId = cached((pkgId) => require(resolve(`packages/${pkgId}/package.json`)))
const getPkgInfo = cached((path) => getPkgInfoFromPkgId(getPkgId(path)))

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
      pkgInfo = require(`${mn}/package.json`)
    } catch (error) {
      pkgInfo = require(normalizePath(require.resolve(mn)).replace(new RegExp(`(?<=${mn}).+`), '/package.json'))
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
  cached,
  isPage,
  isLocalModule,
  isRoutesModule,
  getRoutesMoudleNames,
  getLocalModuleName,
  getVendorPkgInfo,
  stringify
}
