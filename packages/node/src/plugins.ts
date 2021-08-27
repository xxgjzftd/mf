import {
  isRoutesModule,
  getRoutesMoudleNameToPagesMap,
  stringify,
  getLocalModuleName,
  getRoutesOption,
  getPkgId,
  getApps,
  getAppPkgName
} from '@utils.js'
import { building } from '@build'

import type { Plugin } from 'vite'
import type { RouteRecordRaw } from 'vue-router'

interface BaseRoute {
  id: string
  path: string
  name: string
  depth: number
  component: string
  children?: BaseRoute[]
}

const routes = (): Plugin => {
  return {
    name: 'mf-routes',
    resolveId (source) {
      if (isRoutesModule(source)) {
        return source
      }
    },
    async load (id) {
      if (isRoutesModule(id)) {
        const pages = getRoutesMoudleNameToPagesMap()[id]
        const option = getRoutesOption(id)
        const depth = option.depth
        let base = option.base || ''
        base[0] !== '/' && (base = '/' + base)
        base[base.length - 1] !== '/' && (base = base + '/')
        const lmnToPagesMap: Record<string, string[]> = {}
        if (option.type !== 'vue') {
          throw new Error(`currently, 'mf-routes' supports only 'vue-router' based routes.`)
        }
        pages.forEach(
          (path) => {
            const lmn = getLocalModuleName(path)
            lmnToPagesMap[lmn] = lmnToPagesMap[lmn] || []
            lmnToPagesMap[lmn].push(path)
          }
        )
        const brs: BaseRoute[] = []
        Object.keys(lmnToPagesMap).forEach(
          (lmn) => {
            const pages = lmnToPagesMap[lmn]
            const length = pages.length
            if (!length) {
              return
            }
            let lca = pages[0].slice(0, pages[0].lastIndexOf('/'))
            for (let index = 1; index < length; index++) {
              const path = pages[index]
              while (!path.startsWith(lca)) {
                lca = lca.slice(0, lca.lastIndexOf('/'))
              }
            }
            pages.forEach(
              (path) => {
                const raw = base + path.replace(lca, getPkgId(lmn)).replace(/(\/index)?(\..+?)?$/, '')
                const re = option.extends.find((re) => re.id === id)

                const br = Object.assign(
                  {
                    path: raw.replace(/(?<=\/)_/, ':'),
                    name: raw.slice(1).replace(/\//g, '-'),
                    depth: depth
                  },
                  re || {},
                  { id: path, component: path }
                )
                brs.push(br)
              }
            )
          }
        )

        const rrs: RouteRecordRaw[] = []
        brs.forEach(
          (br) => {
            let depth = br.depth
            if (depth === 0) {
              rrs.push(br)
            } else {
              depth--
              const parent = brs.find((inner) => inner.depth === depth && br.path.startsWith(inner.path))
              if (!parent) {
                throw new Error(
                  `can not find parent route of '${br.component}',\n` + `the generated path of which is '${br.path}'.`
                )
              }
              parent.children = parent.children || []
              parent.children.push(br)
            }
          }
        )

        const code = stringify(
          rrs,
          (key, value) => {
            if (key === 'component') {
              return '() => ' + (building ? `mf.load` : `import`) + `("${getLocalModuleName(value)}")`
            }
          }
        )

        return `export default ${code}`
      }
    }
  }
}

const entry = (): Plugin => {
  return {
    name: 'mf-entry',
    transformIndexHtml () {
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module-shim'
          },
          children:
            getApps()
              .map(
                (app) =>
                  `mf.register(` +
                  `"${getAppPkgName(app.name)}", ${stringify(app.conditon)}, ` +
                  `() => ${building ? 'mf.load' : 'import'}("${getAppPkgName(app.name)}"));`
              )
              .join('') + `mf.start()`,
          injectTo: 'head'
        }
      ]
    }
  }
}

export { routes, entry }
