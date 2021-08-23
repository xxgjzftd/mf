import { isRoutesModule, getRoutesMoudleNameToPagesMap, stringify } from '@utils.js'
import { building } from '@build'

import type { Plugin } from 'vite'

const routes = (): Plugin => {
  let rmn: string
  return {
    name: 'mf-routes',
    resolveId (source) {
      if (isRoutesModule(source)) {
        return source
      }
    },
    async load (id) {
      if (rmn && id === rmn) {
        const pages = getRoutesMoudleNameToPagesMap()[rmn]
        // const
        const routeConfigs = pages.map(
          (path) => {
            const raw = path.replace(/packages\/(.+?)\/src\/pages(?=\/)(.*?)(\/index)?\.(vue|tsx)/, '/$1$2')
            const id = raw.replace(/(?<=\/)_/, ':')
            return {
              id,
              path: id,
              name: raw.slice(1).replace(/\//g, '-'),
              component: path
            }
          }
        )
        config.routes['/'].children = routeConfigs
        let routes = []
        Object.keys(config.routes).forEach(
          (id) => {
            const userRouteConfig = config.routes[id]
            const routeConfigIndex = routeConfigs.findIndex((routeConfig) => routeConfig.id === id)
            let routeConfig = userRouteConfig
            if (~routeConfigIndex) {
              routeConfig = routeConfigs[routeConfigIndex]
              Object.assign(routeConfig, userRouteConfig)
            } else {
              if (!routeConfig.component) {
                throw new Error(`自定义路由${id}没有指定相应 'component'。`)
              }
              routeConfigs.push(Object.assign({ id, path: id }, routeConfig))
            }
            if (routeConfig.root) {
              ~routeConfigIndex ? routeConfigs.splice(routeConfigIndex, 1) : routeConfigs.pop()
              routes.push(routeConfig)
            }
          }
        )

        routes = stringify(
          routes,
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

        return `export default ${routes}`
      }
    }
  }
}

export { routes }
