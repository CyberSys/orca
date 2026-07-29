function normalizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 128 ? value.trim() : undefined
}

const CANCEL_TOMBSTONE_TTL_MS = 30_000

/**
 * Tracks one live AbortController per renderer-supplied request id so a superseded Jira call
 * releases its slot in the shared request pool instead of draining it.
 *
 * Cancel can race ahead of run() (renderer abort before IPC registers). Tombstones keep that
 * cancel sticky until run starts, so a late registration aborts immediately.
 */
export class JiraCancellableRequests {
  private readonly controllers = new Map<string, AbortController>()
  private readonly cancelTombstones = new Map<string, number>()

  async run<T>(requestId: unknown, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = normalizeRequestId(requestId)
    const controller = new AbortController()
    if (id) {
      // Reusing an id means the renderer abandoned its previous attempt.
      this.controllers.get(id)?.abort()
      if (this.consumeCancelTombstone(id)) {
        controller.abort()
      }
      this.controllers.set(id, controller)
    }
    try {
      return await task(controller.signal)
    } finally {
      if (id && this.controllers.get(id) === controller) {
        this.controllers.delete(id)
      }
    }
  }

  cancel(requestId: unknown): void {
    const id = normalizeRequestId(requestId)
    if (!id) {
      return
    }
    const live = this.controllers.get(id)
    if (live) {
      live.abort()
      return
    }
    this.cancelTombstones.set(id, Date.now() + CANCEL_TOMBSTONE_TTL_MS)
  }

  private consumeCancelTombstone(id: string): boolean {
    const until = this.cancelTombstones.get(id)
    if (until === undefined) {
      return false
    }
    this.cancelTombstones.delete(id)
    return until > Date.now()
  }
}
