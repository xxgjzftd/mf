import { Task } from './task'

/**
 * @public
 */
export interface Plugin {
  apply(processor: Processor): void
}

/**
 * @public
 */
export interface Context {}

/**
 * @public
 */
export class Processor {
  /**
   * Indicates if processor is running.
   */
  private running = false

  /**
   * Holds all macros tasks will be executed.
   *
   * @remarks
   * Every macro task is executed sequentially. They can only be added before processor is running, by plugin invoking the {@link Processor.task}.
   */
  private macros: Task[] = []

  /**
   * Holds all micros tasks will be executed.
   *
   * @remarks
   * The processor will execute all micro tasks sequentially when each macro task is finished.
   * The next macro task (if exists) will not be executed untill all micro tasks are finished.
   */
  private micros: Task[] = []

  /**
   * Be used as param of {@link Task.actions} which is invoked by {@link Processor.run}.
   */
  private readonly context: Context = {}

  /**
   * Uses a plugin for the processor.
   *
   * @remarks
   * Usually, the plugin should add task to the processor.
   *
   * @param plugin - The plugin to be used
   */
  use (plugin: Plugin) {
    plugin.apply(this)
  }

  /**
   * Creates a task, and add it to the corresponding task queue if couldn't find it.
   *
   * @remarks
   * If there has already been a task which has same name with the name param, this method just return it.
   * The created task is thought of as macro task if the processor is not running, and to be added to the macro task queue.
   * Otherwise it will be thought of as micro task, and to be added to the micro task queue.
   *
   * @param name - The name to be used to create or find task
   *
   * @returns A {@link Task} instance
   *
   */
  task <Action extends Function>(name: string) {
    const queue = this.running ? this.macros : this.micros
    let task = queue.find((task) => task.name === name)
    if (!task) {
      task = new Task<Action>(name)
      queue.push(task)
    }
    return task
  }

  async run () {
    this.running = true
    for (const task of this.macros) {
      await task.run(this.context)
      await this.runMicros()
    }
  }

  private async runMicros () {
    while (this.micros.length) {
      await this.micros.shift()!.run(this.context)
    }
  }
}
