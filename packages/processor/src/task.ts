import type { Context } from 'src/processor'

export class Task<Action extends Function = Function> {
  constructor (readonly name: string) {}

  actions: Action[] = []

  sync = false

  type: 'parallel' | 'sequential' = 'parallel'

  push (action: Action) {
    return this.actions.push(action)
  }

  pop () {
    return this.actions.pop()
  }

  unshift (action: Action) {
    return this.actions.unshift(action)
  }

  shift () {
    return this.actions.shift()
  }

  async run (context: Context) {
    if (this.sync) {
      return this.runSync(context)
    } else {
      switch (this.type) {
        case 'parallel':
          return this.runParallel(context)
        case 'sequential':
          return this.runSequential(context)
        default:
          throw new Error(`illegal type '${this.type}'`)
      }
    }
  }

  private runSync (context: Context) {
    for (const action of this.actions) {
      action(context)
    }
  }

  private async runParallel (context: Context) {
    await Promise.all(this.actions.map((action) => action(context)))
  }

  private async runSequential (context: Context) {
    for (const action of this.actions) {
      await action(context)
    }
  }
}
