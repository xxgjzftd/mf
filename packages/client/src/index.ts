interface ModuleInfo {
  js: string
  css?: string
  imports: Record<string, string[]>
}

interface MF {
  base: string
  modules: Record<string, ModuleInfo>
  load(mn: string): Promise<any>
  unload(mn: string): void
  register(name: string, predicate: () => boolean, load: () => Promise<any>): void
  start(): Promise<any>
}

interface Window {
  mf: MF
  importShim(mn: string): Promise<any>
}

const relList = document.createElement('link').relList
const scriptRel = relList && relList.supports && relList.supports('modulepreload') ? 'modulepreload' : 'preload'
const seen: Record<string, boolean> = {}

const cached = <T extends (string: string) => any>(fn: T) => {
  const cache: Record<string, ReturnType<T>> = Object.create(null)
  return ((string) => cache[string] || (cache[string] = fn(string))) as T
}

const getModuleName = cached(
  (mn) => {
    const index = mn.indexOf('/', mn[0] === '@' ? mn.indexOf('/') + 1 : 0)
    return ~index ? mn.slice(0, index) : mn
  }
)

const getDeps = cached(
  (mn) => {
    let deps: string[] = []
    const info = window.mf.modules[mn] || window.mf.modules[getModuleName(mn)]
    deps.push(info.js)
    info.css && deps.push(info.css)
    if (info.imports) {
      Object.keys(info.imports).forEach(
        (mn) => {
          deps = deps.concat(getDeps(mn))
        }
      )
    }
    return deps
  }
)

const mf = (window.mf = window.mf || {})
mf.load = function (mn) {
  const deps = getDeps(mn)
  return Promise.all(
    deps.map(
      (dep) => {
        if (seen[dep]) return
        seen[dep] = true
        const href = mf.base + dep
        const isCss = dep.endsWith('.css')
        const cssSelector = isCss ? '[rel="stylesheet"]' : ''
        if (document.querySelector(`link[href="${href}"]${cssSelector}`)) {
          return
        }
        const link = document.createElement('link')
        link.rel = isCss ? 'stylesheet' : scriptRel
        if (!isCss) {
          link.as = 'script'
          link.crossOrigin = ''
        }
        link.href = href
        document.head.appendChild(link)
        if (isCss) {
          return new Promise(
            (res, rej) => {
              link.addEventListener('load', res)
              link.addEventListener('error', rej)
            }
          )
        }
      }
    )
  ).then(() => window.importShim(mn))
}

mf.unload = function (mn) {
  const deps = getDeps(mn)
  deps
    .filter((dep) => dep.endsWith('.css'))
    .forEach(
      (dep) => {
        if (seen[dep]) {
          seen[dep] = false
          const href = mf.base + dep
          const link = document.querySelector(`link[href="${href}"][rel="stylesheet"]`)
          link && link.remove()
        }
      }
    )
}

enum MFAppStatus {
  NOT_LOADED,
  NOT_MOUNTED,
  MOUNTED
}

interface UserDefinedApp {
  mount(): Promise<any>
  unmount(): Promise<any>
}

interface BaseApp {
  name: string
  predicate: () => boolean
  load(): Promise<UserDefinedApp>
  status: MFAppStatus
}

type MFApp = BaseApp & Partial<UserDefinedApp>

const apps: MFApp[] = []

mf.register = function (name, predicate, load) {
  apps.push(
    {
      name,
      predicate,
      load,
      status: MFAppStatus.NOT_LOADED
    }
  )
}

const getApps = () => {
  const toBeMounted: MFApp[] = []
  const toBeUnmounted: MFApp[] = []

  apps.forEach(
    (app) => {
      const shouldBeActive = app.predicate()
      switch (app.status) {
        case MFAppStatus.NOT_LOADED:
        case MFAppStatus.NOT_MOUNTED:
          shouldBeActive && toBeMounted.push(app)
          break
        case MFAppStatus.MOUNTED:
          shouldBeActive || toBeUnmounted.push(app)
      }
    }
  )

  return { toBeMounted, toBeUnmounted }
}

const route = async function () {
  const { toBeMounted, toBeUnmounted } = getApps()
  await Promise.all(
    toBeUnmounted.map(
      async (app) => {
        await app.unmount!()
        return mf.unload(app.name)
      }
    )
  )
  await Promise.all(
    toBeMounted.map(
      async (app) => {
        if (app.status === MFAppStatus.NOT_LOADED) {
          Object.assign(app, await app.load())
        }
        await app.mount!()
      }
    )
  )
}

mf.start = route

window.addEventListener('popstate', route)
const pushState = history.pushState
history.pushState = function (...args) {
  pushState(...args)
  route()
}
