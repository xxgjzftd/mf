import vite from 'vite'

import { routes } from './plugins.js'
import { getRoutesMoudleNames, getNormalizedPath, getDevAlias } from './utils.js'

const serve = async (mode?: string) => {
  const { ws, watcher, moduleGraph, listen } = await vite.createServer(
    {
      mode,
      resolve: {
        alias: getDevAlias()
      },
      plugins: [routes()]
    }
  )

  const refresh = (ap: string) =>
    getRoutesMoudleNames(getNormalizedPath(ap)).forEach(
      (rmn) => (moduleGraph.invalidateModule(moduleGraph.getModuleById(rmn)!), ws.send({ type: 'full-reload' }))
    )

  watcher.on('add', refresh)
  watcher.on('unlink', refresh)

  await listen()
}

export { serve }
