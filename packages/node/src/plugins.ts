import {
  isRoutesModule,
  getRoutesMoudleNameToPagesMap,
  stringify,
  getLocalModuleName,
  getRoutesOption,
  getPkgId
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
                const raw = path.replace(lca, getPkgId(lmn)).replace(/(\/index)?(\..+?)?$/, '')
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
              while (depth--) {
                const parent = brs.find((inner) => inner.depth === depth && br.path.startsWith(inner.path))
              }
            }
          }
        )

        const code = stringify(
          brs,
          (key, value) => {
            if (key === 'component') {
              return (
                '() => ' +
                (building
                  ? `mfe.preload("${value.replace(/^packages/, '@vue-mfe')}")`
                  : `import("${value.replace(/packages\/(.+?)\/src(.+)/, '@$1$2')}")`)
              )
            }
          }
        )

        return `export default ${code}`
      }
    }
  }
}

export { routes }
