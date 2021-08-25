interface ModuleInfo {
  js: string
  css?: string
  imports: Record<string, string[]>
}

interface MF {
  base: string
  modules: Record<string, ModuleInfo>
  preload(mn: string): Promise<any>
  register(name: string, condition: () => boolean, load: () => Promise<any>): void
}

interface Window {
  mf: MF
  importShim(mn: string): Promise<any>
}

const relList = document.createElement('link').relList
const scriptRel = relList && relList.supports && relList.supports('modulepreload') ? 'modulepreload' : 'preload'
const seen: Record<string, true> = {}

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
mf.preload = function preload (mn) {
  const deps = getDeps(mn)
  return Promise.all(
    deps.map(
      (dep) => {
        if (dep in seen) return
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

mf.register
