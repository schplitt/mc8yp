export class AsyncSemaphore {
  readonly #maxConcurrency: number
  #activeCount = 0
  readonly #waiters: Array<() => void> = []

  constructor(maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error('maxConcurrency must be a positive integer.')
    }

    this.#maxConcurrency = maxConcurrency
  }

  get activeCount(): number {
    return this.#activeCount
  }

  async acquire(): Promise<() => void> {
    if (this.#activeCount >= this.#maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve)
      })
    }

    this.#activeCount += 1
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.#activeCount -= 1
      this.#waiters.shift()?.()
    }
  }
}
