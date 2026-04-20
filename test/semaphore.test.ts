import { describe, expect, it } from 'vitest'
import { AsyncSemaphore } from '../src/codemode/semaphore'

describe('AsyncSemaphore', () => {
  it('enforces the configured max concurrency of three', async () => {
    const semaphore = new AsyncSemaphore(3)
    const releaseFirst = await semaphore.acquire()
    const releaseSecond = await semaphore.acquire()
    const releaseThird = await semaphore.acquire()
    const fourthAcquire = semaphore.acquire()

    expect(semaphore.activeCount).toBe(3)

    let resolved = false
    void fourthAcquire.then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    releaseFirst()
    const releaseFourth = await fourthAcquire
    expect(semaphore.activeCount).toBe(3)

    releaseSecond()
    releaseThird()
    releaseFourth()
    expect(semaphore.activeCount).toBe(0)
  })

  it('limits concurrent acquisitions and releases queued waiters', async () => {
    const semaphore = new AsyncSemaphore(1)
    const releaseFirst = await semaphore.acquire()
    const secondAcquire = semaphore.acquire()

    expect(semaphore.activeCount).toBe(1)

    let resolved = false
    void secondAcquire.then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    releaseFirst()
    const releaseSecond = await secondAcquire
    expect(semaphore.activeCount).toBe(1)

    releaseSecond()
    expect(semaphore.activeCount).toBe(0)
  })
})