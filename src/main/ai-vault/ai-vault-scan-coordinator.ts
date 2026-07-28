import type { AiVaultListResult } from '../../shared/ai-vault-types'

type ScanEntry = {
  controller: AbortController
  promise: Promise<AiVaultListResult>
  waiterCount: number
}

export class AiVaultScanCoordinator {
  private readonly entries = new Map<string, ScanEntry>()

  run(args: {
    key: string
    signal?: AbortSignal
    start: (signal: AbortSignal) => Promise<AiVaultListResult>
  }): Promise<AiVaultListResult> {
    if (args.signal?.aborted) {
      return Promise.reject(scanCancellationError())
    }
    let entry = this.entries.get(args.key)
    if (!entry) {
      entry = this.createEntry(args.key, args.start)
      this.entries.set(args.key, entry)
    }
    return this.attach(args.key, entry, args.signal)
  }

  private createEntry(
    key: string,
    start: (signal: AbortSignal) => Promise<AiVaultListResult>
  ): ScanEntry {
    const controller = new AbortController()
    const entry: ScanEntry = {
      controller,
      promise: Promise.resolve().then(() => start(controller.signal)),
      waiterCount: 0
    }
    void entry.promise.then(
      () => this.removeEntry(key, entry),
      () => this.removeEntry(key, entry)
    )
    return entry
  }

  private attach(key: string, entry: ScanEntry, signal?: AbortSignal): Promise<AiVaultListResult> {
    entry.waiterCount++
    return new Promise((resolve, reject) => {
      let attached = true
      const detach = (): void => {
        if (!attached) {
          return
        }
        attached = false
        signal?.removeEventListener('abort', onAbort)
        entry.waiterCount--
        if (entry.waiterCount === 0) {
          this.removeEntry(key, entry)
          entry.controller.abort()
        }
      }
      const onAbort = (): void => {
        detach()
        reject(scanCancellationError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      void entry.promise.then(
        (result) => {
          if (attached) {
            detach()
            resolve(result)
          }
        },
        (error) => {
          if (attached) {
            detach()
            reject(error)
          }
        }
      )
    })
  }

  private removeEntry(key: string, entry: ScanEntry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }
}

function scanCancellationError(): Error {
  const error = new Error('Agent Session History scan was cancelled')
  error.name = 'AbortError'
  return error
}
