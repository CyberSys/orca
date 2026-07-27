export function throwIfRemoteSessionScanCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  const error = new Error('Agent Session History scan was cancelled')
  error.name = 'AbortError'
  throw error
}
