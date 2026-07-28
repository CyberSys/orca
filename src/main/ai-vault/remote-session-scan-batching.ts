import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { throwIfRemoteSessionScanCancelled } from './remote-session-scan-cancellation'

// Batching bounds concurrent remote round trips; the yield between batches keeps
// the process responsive, and the batch boundary is where cancellation lands.
export async function mapRemoteScanBatches<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
  signal?: AbortSignal
): Promise<U[]> {
  const results: U[] = []
  for (let index = 0; index < items.length; index += concurrency) {
    throwIfRemoteSessionScanCancelled(signal)
    results.push(...(await Promise.all(items.slice(index, index + concurrency).map(mapper))))
    await yieldToEventLoop()
  }
  return results
}
