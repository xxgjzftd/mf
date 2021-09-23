import {
  isRoutesModule,
  getRoutesMoudleNameToPagesMap,
  stringify,
  getLocalModuleName,
  getRoutesOption,
  getPkgId,
  getApps,
  getAppPkgName,
  getPkgName,
  getLocalModulePath
} from 'src/utils'
import { building } from 'src/build'

import type { Plugin } from 'vite'

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
        const pnToPagesMap: Record<string, string[]> = {}
        pages.forEach(
          (path) => {
            const pn = getPkgName(getLocalModuleName(path)!)
            pnToPagesMap[pn] = pnToPagesMap[pn] || []
            pnToPagesMap[pn].push(path)
          }
        )
        const brs: BaseRoute[] = []
        Object.keys(pnToPagesMap).forEach(
          (pn) => {
            const pages = pnToPagesMap[pn]
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
                const raw = base + path.replace(lca, getPkgId(pn)).replace(/(\/index)?(\..+?)?$/, '')
                const re = option.extends.find((re) => re.id === path)

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

        const rrs: BaseRoute[] = []
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
              return (
                '() => ' +
                (building ? `mf.load` : `import`) +
                `("${building ? getLocalModuleName(value) : '/' + value}")`
              )
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
            type: building ? 'module-shim' : 'module',
            noshim: building ? false : true
          },
          children:
            getApps()
              .map(
                (app) =>
                  `mf.register(` +
                  `"${getAppPkgName(app.name)}", ${stringify(app.predicate)}, ` +
                  `() => ${building ? 'mf.load' : 'import'}` +
                  `("${building ? getAppPkgName(app.name) : '/' + getLocalModulePath(getAppPkgName(app.name))}"));`
              )
              .join('') + `mf.start()`,
          injectTo: 'head'
        }
      ]
    }
  }
}

export { routes, entry }
