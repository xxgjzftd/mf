import vite from 'vite'
import { URL } from 'url'

import { entry, routes } from 'src/plugins.js'
import { config, getRoutesMoudleNames, getNormalizedPath, getDevAlias } from 'src/utils.js'
import * as utils from 'src/utils'

import type { AddressInfo } from 'net'

const serve = async (mode?: string) => {
  const appNameToOriginMap: Record<string, string> = {}
  return Promise.all(
    config.apps.map(
      async (app) => {
        typeof app.vite === 'function' && (app.vite = app.vite({ command: 'serve', mode }, utils))
        const { ws, watcher, moduleGraph, listen } = await vite.createServer(
          vite.mergeConfig(
            {
              mode,
              resolve: {
                alias: getDevAlias()
              },
              plugins: [
                routes(),
                entry(),
                {
                  name: 'mf-serve',
                  configureServer (server) {
                    server.middlewares.use(
                      (req, res, next) => {
                        if (req.headers.accept?.includes('text/html')) {
                          const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname
                          const target = config.apps.find((app) => app.predicate!(pathname))
                          if (!target) {
                            throw new Error(`There is no corresponding app of '${pathname}'.`)
                          }
                          if (target.name === app.name) {
                            next()
                          } else {
                            res.writeHead(301, { Location: appNameToOriginMap[target.name] + pathname })
                            res.end()
                          }
                        } else {
                          next()
                        }
                      }
                    )
                  }
                } as vite.Plugin
              ]
            },
            app.vite!
          )
        )

        const refresh = (ap: string) =>
          getRoutesMoudleNames(getNormalizedPath(ap)).forEach(
            (rmn) => (moduleGraph.invalidateModule(moduleGraph.getModuleById(rmn)!), ws.send({ type: 'full-reload' }))
          )

        watcher.on('add', refresh)
        watcher.on('unlink', refresh)

        const server = await listen()
        const { address, port } = server.httpServer!.address() as AddressInfo
        const protocol = server.config.server.https ? 'https' : 'http'
        appNameToOriginMap[app.name] = `${protocol}://${address}:${port}`
      }
    )
  )
}

export { serve }
